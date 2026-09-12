import {
  type ApiTransport,
  createClient,
  type OpenCloudBoxClient,
} from '../api/generated/client.js'
import { OcboxError } from '../errors/index.js'
import { AuthenticatedHttpClient } from './authenticated-client.js'
import { type HostedProtocolEndpoints, DEFAULT_HTTP_TIMEOUT_MILLISECONDS } from './config.js'
import { AuthBindingError, newRequestId } from './errors.js'
import type { FetchPort } from './ports.js'
import type { HostedTokenManager } from './token-manager.js'

const defaultFetch: FetchPort = (input, init) => fetch(input, init)
// The execution contract can retain up to 1 MiB for each output stream; 16 MiB
// leaves room for both streams and worst-case JSON escaping while bounding memory.
const DEFAULT_HOSTED_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024

export interface AuthenticatedTransportOptions {
  readonly fetch?: FetchPort | undefined
  readonly timeoutMilliseconds?: number | undefined
  /** Certified API base the bearer was minted for; defaults to the bound issuer. */
  readonly apiOrigin?: string | undefined
  /** Maximum generated-client response body size; defaults to 16 MiB. */
  readonly maxResponseBytes?: number | undefined
}

type HeaderInput = NonNullable<RequestInit['headers']>

function headerValues(headers: HeaderInput | undefined, name: string): string[] {
  if (headers === undefined) return []
  if (headers instanceof Headers) {
    const value = headers.get(name)
    return value === null ? [] : [value]
  }
  if (Array.isArray(headers)) {
    const values: string[] = []
    for (const [key, value] of headers) {
      if (key.toLowerCase() === name) values.push(value)
    }
    return values
  }
  const values: string[] = []
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) {
      const value = headers[key]
      if (typeof value === 'string') values.push(value)
    }
  }
  return values
}

function singleHeaderValue(headers: HeaderInput | undefined, name: string): string | undefined {
  const values = headerValues(headers, name)
  if (values.length > 1) {
    throw new TypeError(`The ${name} header must appear at most once`)
  }
  return values[0]
}

function plainHeaders(headers: HeaderInput | undefined): Record<string, string> {
  const merged: Record<string, string> = {}
  if (headers === undefined) return merged
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      merged[key] = value
    })
    return merged
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) merged[key] = value
    return merged
  }
  for (const key of Object.keys(headers)) {
    const value: string | string[] | undefined = headers[key]
    if (typeof value === 'string') merged[key] = value
    else if (Array.isArray(value) && typeof value[0] === 'string') merged[key] = value[0]
  }
  return merged
}

/** Removes headers whose canonical value is owned by the authenticated layer. */
function withoutManagedHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (headers === undefined) return undefined
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase()
    if (normalized !== 'authorization' && normalized !== 'idempotency-key') result[key] = value
  }
  return result
}

function responseReadError(
  code: 'OPERATION_CANCELLED' | 'PROVIDER_AUTH' | 'PROVIDER_TIMEOUT' | 'PROVIDER_UNAVAILABLE',
  message: string,
): OcboxError {
  return new OcboxError({ code, message, requestId: newRequestId() })
}

/**
 * Wraps a provider body so generated `response.text()` calls have a byte
 * ceiling, cancellation, and a deadline. The response is not eagerly read,
 * preserving the transport contract while preventing unbounded buffering.
 */
function boundedResponse(
  response: Response,
  options: {
    readonly maxBytes: number
    readonly signal?: AbortSignal | undefined
    readonly timeoutMilliseconds: number
  },
): Response {
  const reader = response.body?.getReader()
  if (reader === undefined) return response

  let bytes = 0
  let failure: OcboxError | null = null
  let pendingReject: ((error: unknown) => void) | null = null
  let settled = false
  const fail = (error: OcboxError): void => {
    if (failure !== null || settled) return
    failure = error
    void reader.cancel().catch(() => undefined)
    pendingReject?.(error)
  }
  const timer = setTimeout(() => {
    fail(
      responseReadError(
        'PROVIDER_TIMEOUT',
        'The hosted service response body did not complete in time',
      ),
    )
  }, options.timeoutMilliseconds)
  timer.unref?.()
  const onAbort = (): void => {
    fail(responseReadError('OPERATION_CANCELLED', 'The hosted service response was cancelled'))
  }
  if (options.signal?.aborted === true) onAbort()
  else options.signal?.addEventListener('abort', onAbort, { once: true })
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength)
    if (Number.isSafeInteger(declaredBytes) && declaredBytes > options.maxBytes) {
      fail(
        responseReadError(
          'PROVIDER_AUTH',
          'The hosted service response exceeded the safe size limit',
        ),
      )
    }
  }

  const cleanup = (): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
  const body = new ReadableStream<Uint8Array>({
    async cancel(reason): Promise<void> {
      cleanup()
      await reader.cancel(reason).catch(() => undefined)
    },
    async pull(controller): Promise<void> {
      if (failure !== null) {
        cleanup()
        controller.error(failure)
        return
      }
      try {
        const chunk = await new Promise<Awaited<ReturnType<typeof reader.read>>>(
          (resolve, reject) => {
            pendingReject = reject
            void reader.read().then(resolve, reject)
          },
        )
        pendingReject = null
        if (chunk.done) {
          cleanup()
          controller.close()
          return
        }
        bytes += chunk.value.byteLength
        if (bytes > options.maxBytes) {
          const error = responseReadError(
            'PROVIDER_AUTH',
            'The hosted service response exceeded the safe size limit',
          )
          fail(error)
          cleanup()
          controller.error(error)
          return
        }
        controller.enqueue(chunk.value)
      } catch (error) {
        pendingReject = null
        cleanup()
        controller.error(
          error instanceof OcboxError
            ? error
            : responseReadError(
                'PROVIDER_UNAVAILABLE',
                'The hosted service response could not be read',
              ),
        )
      }
    },
  })
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  })
}

/**
 * Adapts the hardened bearer pipeline to the generated client's transport
 * port, so the hosted provider (T14) never reimplements origin binding,
 * replay-safe refresh, redirect refusal, or timeouts. Bearer injection, the
 * single serialized refresh-and-retry for replayable requests, and
 * reuse/revocation clearing all stay inside `AuthenticatedHttpClient`;
 * per-operation idempotency keys flow through from the generated client, and
 * the caller's `AbortSignal` travels with the request.
 */
export function createAuthenticatedTransport(
  tokens: HostedTokenManager,
  options: AuthenticatedTransportOptions = {},
): ApiTransport {
  const apiOrigin = options.apiOrigin ?? tokens.boundIssuer
  if (apiOrigin === undefined) {
    throw new TypeError(
      'An authenticated transport requires an explicit API base or an issuer-bound token manager',
    )
  }
  const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_HTTP_TIMEOUT_MILLISECONDS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_HOSTED_RESPONSE_LIMIT_BYTES
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError('The hosted response limit must be a positive integer')
  }
  const client = new AuthenticatedHttpClient({
    apiOrigin,
    fetch: options.fetch ?? defaultFetch,
    timeoutMilliseconds,
    tokens,
  })
  return {
    async fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
      const request = input instanceof Request ? input : null
      const url = request === null ? input : request.url
      const method = init.method ?? request?.method ?? 'GET'
      // RequestInit headers replace a Request object's headers under Fetch
      // semantics. Resolve one effective set before extracting the replay key
      // so a hidden second source can never influence retry eligibility.
      const effectiveHeaders = init.headers ?? request?.headers
      const idempotencyKey = singleHeaderValue(effectiveHeaders, 'idempotency-key')
      // An explicit null body/signal in RequestInit clears the corresponding
      // Request value. Nullish coalescing would accidentally resurrect a
      // Request body or signal that Fetch semantics say the init replaces.
      const hasInitBody = Object.hasOwn(init, 'body')
      const rawBody = hasInitBody ? init.body : (request?.body ?? undefined)
      const body = rawBody === null ? undefined : rawBody
      if (body !== undefined && typeof body !== 'string') {
        throw new TypeError('The hosted API transport carries JSON string bodies only')
      }
      const hasInitSignal = Object.hasOwn(init, 'signal')
      const rawSignal = hasInitSignal ? init.signal : (request?.signal ?? undefined)
      const signal = rawSignal === null ? undefined : rawSignal
      const result = await client.request({
        ...(body === undefined ? {} : { body }),
        headers: plainHeaders(effectiveHeaders),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        method,
        ...(signal === undefined ? {} : { signal }),
        url: typeof url === 'string' || url instanceof URL ? url : String(url),
      })
      return boundedResponse(result.response, {
        maxBytes: maxResponseBytes,
        ...(signal === undefined ? {} : { signal }),
        timeoutMilliseconds,
      })
    },
  }
}

export interface HostedApiClientOptions {
  /** Protocol endpoints sharing the API base, state, identity, and metadata with login. */
  readonly protocol: HostedProtocolEndpoints
  readonly tokens: HostedTokenManager
  readonly fetch?: FetchPort | undefined
  readonly timeoutMilliseconds?: number | undefined
  readonly maxResponseBytes?: number | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
}

/**
 * Composes the generated `/v1` client over the authenticated transport for a
 * single configured API base. The issuer is passed through untouched so the
 * generated client's own `/v1` normalization stays the single URL model;
 * `ApiResult` request IDs and replay flags surface per call, while error
 * catalogue mapping stays with the hosted provider layer.
 */
export function createHostedApiClient(options: HostedApiClientOptions): OpenCloudBoxClient {
  if (
    options.tokens.boundIssuer !== undefined &&
    options.tokens.boundIssuer !== options.protocol.issuer
  ) {
    throw new AuthBindingError(
      undefined,
      'The generated client API base does not match the credential issuance binding',
    )
  }
  const transport = createAuthenticatedTransport(options.tokens, {
    apiOrigin: options.protocol.issuer,
    fetch: options.fetch,
    timeoutMilliseconds: options.timeoutMilliseconds,
    maxResponseBytes: options.maxResponseBytes,
  })
  const headers = withoutManagedHeaders(options.headers)
  return createClient(options.protocol.issuer, {
    transport,
    ...(headers === undefined ? {} : { headers }),
  })
}

import {
  type ApiTransport,
  createClient,
  type OpenCloudBoxClient,
} from '../api/generated/client.js'
import { AuthenticatedHttpClient } from './authenticated-client.js'
import { type HostedProtocolEndpoints, DEFAULT_HTTP_TIMEOUT_MILLISECONDS } from './config.js'
import type { FetchPort } from './ports.js'
import type { HostedTokenManager } from './token-manager.js'

const defaultFetch: FetchPort = (input, init) => fetch(input, init)

export interface AuthenticatedTransportOptions {
  readonly fetch?: FetchPort | undefined
  readonly timeoutMilliseconds?: number | undefined
  /** Certified API base the bearer was minted for; defaults to the bound issuer. */
  readonly apiOrigin?: string | undefined
}

type HeaderInput = NonNullable<RequestInit['headers']>

function headerValue(headers: HeaderInput | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined
  if (headers instanceof Headers) {
    const value = headers.get(name)
    return value === null ? undefined : value
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === name) return value
    }
    return undefined
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) {
      const value: string | string[] | undefined = headers[key]
      return Array.isArray(value) ? value[0] : value
    }
  }
  return undefined
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
  const client = new AuthenticatedHttpClient({
    apiOrigin: options.apiOrigin ?? tokens.boundIssuer,
    fetch: options.fetch ?? defaultFetch,
    timeoutMilliseconds: options.timeoutMilliseconds ?? DEFAULT_HTTP_TIMEOUT_MILLISECONDS,
    tokens,
  })
  return {
    async fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
      const request = input instanceof Request ? input : null
      const url = request === null ? input : request.url
      const method = init.method ?? request?.method ?? 'GET'
      const idempotencyKey =
        headerValue(init.headers, 'idempotency-key') ??
        (request === null ? undefined : (request.headers.get('idempotency-key') ?? undefined))
      const rawBody = init.body ?? request?.body ?? undefined
      const body = rawBody === null ? undefined : rawBody
      if (body !== undefined && typeof body !== 'string') {
        throw new TypeError('The hosted API transport carries JSON string bodies only')
      }
      const rawSignal = init.signal ?? request?.signal ?? undefined
      const signal = rawSignal === null ? undefined : rawSignal
      const result = await client.request({
        ...(body === undefined ? {} : { body }),
        headers: plainHeaders(init.headers),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        method,
        ...(signal === undefined ? {} : { signal }),
        url: typeof url === 'string' || url instanceof URL ? url : String(url),
      })
      return result.response
    },
  }
}

export interface HostedApiClientOptions {
  /** Protocol endpoints sharing the API base, state, identity, and metadata with login. */
  readonly protocol: HostedProtocolEndpoints
  readonly tokens: HostedTokenManager
  readonly fetch?: FetchPort | undefined
  readonly timeoutMilliseconds?: number | undefined
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
  const transport = createAuthenticatedTransport(options.tokens, {
    apiOrigin: options.tokens.boundIssuer ?? options.protocol.issuer,
    fetch: options.fetch,
    timeoutMilliseconds: options.timeoutMilliseconds,
  })
  return createClient(options.protocol.issuer, {
    transport,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  })
}

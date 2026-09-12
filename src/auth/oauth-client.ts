import { z } from 'zod'
import type { CliTokenPair } from '../api/generated/client.js'
import { OcboxError } from '../errors/index.js'
import { newRequestId } from './errors.js'
import type { FetchPort } from './ports.js'

const MAX_RESPONSE_BYTES = 64 * 1024
/**
 * The protocol parse ceiling is also the wire ceiling: token-pair payloads must
 * parse within `MAX_RESPONSE_BYTES` (64 KiB, matching the pinned contract-shape
 * bound) and a successful revocation response carries no meaningful content, so
 * anything above 64 KiB is detected and discarded (stopped mid-stream) instead
 * of trickling through the socket or being mistaken for success.
 */
const PROVIDER_CODE_PATTERN = /^[A-Za-z0-9_]{1,64}$/

/** Strict runtime shape of the documented CLI token pair. */
export const CliTokenPairSchema = z.strictObject({
  accessToken: z
    .string()
    .min(32)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().min(1).max(3600),
  scope: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-z0-9._:-]+(?: [a-z0-9._:-]+)*$/),
  refreshToken: z
    .string()
    .min(32)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
})

export type { CliTokenPair }

interface ErrorEnvelope {
  readonly code?: unknown
  readonly requestId?: unknown
}

function errorFromBody(text: string): ErrorEnvelope {
  if (text.length === 0 || text.length > MAX_RESPONSE_BYTES) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const error = (parsed as { error?: unknown }).error
    if (error === null || typeof error !== 'object' || Array.isArray(error)) return {}
    return {
      code: (error as { code?: unknown }).code,
      requestId: (parsed as { requestId?: unknown }).requestId,
    }
  } catch {
    return {}
  }
}

function providerCodeOf(envelope: ErrorEnvelope): string | undefined {
  return typeof envelope.code === 'string' && PROVIDER_CODE_PATTERN.test(envelope.code)
    ? envelope.code
    : undefined
}

function unsafeMessage(message: string): OcboxError {
  return new OcboxError({
    code: 'PROVIDER_AUTH',
    message,
    requestId: newRequestId(),
  })
}

/**
 * Reads at most the protocol ceiling (`MAX_RESPONSE_BYTES`) from the response
 * and cancels the body beyond that, so an oversized stream cannot buffer
 * unboundedly in the CLI process or be mistaken for a valid payload.
 */
async function readBoundedResponseText(response: Response): Promise<string> {
  const body = response.body
  if (body === null) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder('utf8', { fatal: false })
  let bytes = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new OversizedResponseError()
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  return text
}

class OversizedResponseError extends Error {
  constructor() {
    super('Authentication response exceeded the bounded read size')
    this.name = 'OversizedResponseError'
  }
}

/**
 * Forces `redirect: 'manual'` on every protocol request. The redirect policy is
 * applied last so a caller-supplied `init` can never override it.
 */
export function withRedirectDisabled(init: RequestInit): RequestInit {
  // OAuth token/revocation endpoints must never hand credentials across a
  // redirect; manual-mode makes any 3xx surface as an opaque failure instead.
  return { ...init, redirect: 'manual' }
}

/**
 * Minimal public-client OAuth protocol client for the CLI token and revocation
 * endpoints. It attaches no credentials to the protocol requests and never
 * lets fetch follow a redirect (manual mode): token, verifier, and refresh
 * material can only ever travel to the validated configured endpoints. It never
 * logs or embeds tokens, codes, or verifiers in errors.
 */
/** Endpoints, client id, transport, and bound timeout for the protocol client. */
export interface CliOAuthClientOptions {
  readonly tokenEndpoint: string
  readonly revocationEndpoint: string
  readonly clientId: string
  readonly fetch: FetchPort
  readonly timeoutMilliseconds: number
}

export interface ExchangeAuthorizationCodeInput {
  readonly code: string
  readonly redirectUri: string
  readonly codeVerifier: string
  readonly signal?: AbortSignal | undefined
}

export interface RefreshInput {
  readonly refreshToken: string
  readonly signal?: AbortSignal | undefined
}

export interface RevokeInput {
  readonly token: string
  readonly signal?: AbortSignal | undefined
}

/** Narrow OAuth protocol port so orchestration can be faked in tests. */
export interface CliOAuthClientPort {
  exchangeAuthorizationCode(input: ExchangeAuthorizationCodeInput): Promise<CliTokenPair>
  refresh(input: RefreshInput): Promise<CliTokenPair>
  revoke(input: RevokeInput): Promise<void>
}

interface TimeoutSignal {
  readonly signal: AbortSignal
  readonly dispose: () => void
  readonly didTimeout: () => boolean
  readonly didCancel: () => boolean
}

function withTimeout(signal: AbortSignal | undefined, milliseconds: number): TimeoutSignal {
  const controller = new AbortController()
  let timedOut = false
  let cancelled = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, milliseconds)
  timer.unref?.()
  const onAbort = (): void => {
    cancelled = true
    controller.abort()
  }
  if (signal !== undefined) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    didCancel: () => cancelled,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
    signal: controller.signal,
  }
}

function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (header === null) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400) return Math.trunc(seconds)
  const date = Date.parse(header)
  if (Number.isFinite(date)) {
    const delta = Math.max(0, Math.ceil((date - Date.now()) / 1_000))
    return delta <= 86_400 ? delta : undefined
  }
  return undefined
}

/**
 * Minimal public-client OAuth protocol client for the CLI token and revocation
 * endpoints. It never logs or embeds tokens, codes, or verifiers in errors.
 */
export class CliOAuthClient implements CliOAuthClientPort {
  readonly #options: CliOAuthClientOptions

  constructor(options: CliOAuthClientOptions) {
    this.#options = options
  }

  async exchangeAuthorizationCode(input: ExchangeAuthorizationCodeInput): Promise<CliTokenPair> {
    return this.#postToken(
      {
        clientId: this.#options.clientId,
        code: input.code,
        codeVerifier: input.codeVerifier,
        grantType: 'authorization_code',
        redirectUri: input.redirectUri,
      },
      input.signal,
    )
  }

  async refresh(input: RefreshInput): Promise<CliTokenPair> {
    return this.#postToken(
      {
        clientId: this.#options.clientId,
        grantType: 'refresh_token',
        refreshToken: input.refreshToken,
      },
      input.signal,
    )
  }

  async revoke(input: RevokeInput): Promise<void> {
    const timeout = withTimeout(input.signal, this.#options.timeoutMilliseconds)
    try {
      const response = await this.#options.fetch(
        this.#options.revocationEndpoint,
        withRedirectDisabled({
          body: JSON.stringify({ clientId: this.#options.clientId, token: input.token }),
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          method: 'POST',
          signal: timeout.signal,
        }),
      )
      let text = ''
      let readFailed = false
      try {
        text = await readBoundedResponseText(response)
      } catch {
        readFailed = true
      }
      if (timeout.didTimeout() || timeout.didCancel()) throw this.#transportError(timeout)
      if (!response.ok) throw this.#mapError(response, text)
      // The contract defines no meaningful success content (204/200); a body
      // that cannot be read within the 64 KiB ceiling is a protocol violation,
      // never accepted silently as success.
      if (readFailed) throw unsafeMessage('The revocation response was not understood')
    } catch (error) {
      if (error instanceof OcboxError) throw error
      throw this.#transportError(timeout)
    } finally {
      timeout.dispose()
    }
  }

  async #postToken(
    body: Readonly<Record<string, string>>,
    signal: AbortSignal | undefined,
  ): Promise<CliTokenPair> {
    const timeout = withTimeout(signal, this.#options.timeoutMilliseconds)
    try {
      const response = await this.#options.fetch(
        this.#options.tokenEndpoint,
        withRedirectDisabled({
          body: JSON.stringify(body),
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          method: 'POST',
          signal: timeout.signal,
        }),
      )
      let text = ''
      let readFailed = false
      try {
        text = await readBoundedResponseText(response)
      } catch {
        // The bounded read shield (response size/tearing) is not diagnostic;
        // the payload can never be trusted or echoed.
        readFailed = true
      }
      if (timeout.didTimeout() || timeout.didCancel()) throw this.#transportError(timeout)
      if (!response.ok) throw this.#mapError(response, text)
      if (readFailed || text.length === 0) {
        throw unsafeMessage('The authentication response was not understood')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw unsafeMessage('The authentication response was not understood')
      }
      const result = CliTokenPairSchema.safeParse(parsed)
      if (!result.success) throw unsafeMessage('The authentication response was not understood')
      return result.data
    } catch (error) {
      if (error instanceof OcboxError) throw error
      throw this.#transportError(timeout)
    } finally {
      timeout.dispose()
    }
  }

  #mapError(response: Response, text: string): OcboxError {
    const envelope = errorFromBody(text)
    const requestId = newRequestId()
    const providerCode = providerCodeOf(envelope)
    const headerRequestId = response.headers.get('x-request-id')
    const retryAfter = retryAfterSeconds(response)
    const details: Record<string, string | number> = {}
    if (retryAfter !== undefined) details['retryAfterSeconds'] = retryAfter
    if (headerRequestId !== null && /^[A-Za-z0-9._:-]{1,128}$/.test(headerRequestId)) {
      details['providerRequestId'] = headerRequestId
    }
    const base = {
      ...(providerCode === undefined ? {} : { providerCode }),
      ...(Object.keys(details).length === 0 ? {} : { details }),
      requestId,
    }
    switch (response.status) {
      case 429:
        return new OcboxError({
          ...base,
          code: 'PROVIDER_RATE_LIMIT',
          message: 'The authentication service is rate limiting requests; retry later',
        })
      case 503:
        return new OcboxError({
          ...base,
          code: 'PROVIDER_UNAVAILABLE',
          message: 'The hosted authentication service is temporarily unavailable',
        })
      case 403:
        return new OcboxError({
          ...base,
          code: 'AUTH_FORBIDDEN',
          message: 'The authentication service refused the request',
        })
      case 400:
      case 401:
        return new OcboxError({
          ...base,
          code: 'AUTH_REQUIRED',
          message: 'The authorization grant is not valid; run `ocbox auth login` again',
        })
      default:
        return new OcboxError({
          ...base,
          code: 'PROVIDER_AUTH',
          message: 'The authentication service returned an unexpected response',
        })
    }
  }

  #transportError(timeout: TimeoutSignal): OcboxError {
    if (timeout.didTimeout()) {
      return new OcboxError({
        code: 'PROVIDER_TIMEOUT',
        message: 'The hosted authentication service did not respond in time',
        requestId: newRequestId(),
      })
    }
    if (timeout.didCancel()) {
      return new OcboxError({
        code: 'OPERATION_CANCELLED',
        message: 'The authentication request was cancelled',
        requestId: newRequestId(),
      })
    }
    return new OcboxError({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'The hosted authentication service could not be reached',
      requestId: newRequestId(),
    })
  }
}

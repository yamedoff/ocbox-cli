import { z } from 'zod'
import type { CliTokenPair } from '../api/generated/client.js'
import { OcboxError } from '../errors/index.js'
import { newRequestId } from './errors.js'
import type { FetchPort } from './ports.js'

const MAX_RESPONSE_BYTES = 64 * 1024
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
  scope: z.string().min(1).max(256),
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
}

function withTimeout(signal: AbortSignal | undefined, milliseconds: number): TimeoutSignal {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, milliseconds)
  timer.unref?.()
  const onAbort = (): void => controller.abort()
  if (signal !== undefined) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
    didTimeout: () => timedOut,
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
      const response = await this.#options.fetch(this.#options.revocationEndpoint, {
        body: JSON.stringify({ clientId: this.#options.clientId, token: input.token }),
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        method: 'POST',
        signal: timeout.signal,
      })
      const text = await response.text()
      if (!response.ok) throw this.#mapError(response, text, timeout.didTimeout())
    } catch (error) {
      if (error instanceof OcboxError) throw error
      throw this.#transportError(timeout.didTimeout())
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
      const response = await this.#options.fetch(this.#options.tokenEndpoint, {
        body: JSON.stringify(body),
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        method: 'POST',
        signal: timeout.signal,
      })
      const text = await response.text()
      if (!response.ok) throw this.#mapError(response, text, timeout.didTimeout())
      if (text.length === 0 || text.length > MAX_RESPONSE_BYTES) {
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
      throw this.#transportError(timeout.didTimeout())
    } finally {
      timeout.dispose()
    }
  }

  #mapError(response: Response, text: string, timedOut: boolean): OcboxError {
    if (timedOut) return this.#transportError(true)
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

  #transportError(timedOut: boolean): OcboxError {
    return timedOut
      ? new OcboxError({
          code: 'PROVIDER_TIMEOUT',
          message: 'The hosted authentication service did not respond in time',
          requestId: newRequestId(),
        })
      : new OcboxError({
          code: 'PROVIDER_UNAVAILABLE',
          message: 'The hosted authentication service could not be reached',
          requestId: newRequestId(),
        })
  }
}

import { OcboxError } from '../errors/index.js'
import { LoginRequiredError, newRequestId } from './errors.js'
import type { FetchPort } from './ports.js'
import type { HostedTokenManager } from './token-manager.js'

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE'])

export interface AuthenticatedRequest {
  readonly method: string
  readonly url: string | URL
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly body?: string | undefined
  readonly signal?: AbortSignal | undefined
  readonly idempotencyKey?: string | undefined
}

export interface AuthenticatedFetchResult {
  readonly response: Response
  readonly requestId: string | null
  readonly retryAfterSeconds: number | null
}

function retryAfterSecondsOf(response: Response): number | null {
  const header = response.headers.get('retry-after')
  if (header === null) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400) return Math.trunc(seconds)
  const date = Date.parse(header)
  if (!Number.isFinite(date)) return null
  const delta = Math.ceil((date - Date.now()) / 1_000)
  return delta >= 0 && delta <= 86_400 ? delta : null
}

function deleteOwnedHeader(headers: Record<string, string>, name: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) delete headers[key]
  }
}

export interface AuthenticatedHttpClientOptions {
  readonly tokens: HostedTokenManager
  readonly fetch: FetchPort
  readonly timeoutMilliseconds: number
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

/**
 * Attaches access tokens only as `Authorization: Bearer`. One eligible 401
 * triggers a single serialized refresh and at most one retry of an
 * idempotent/safe request. Refresh reuse or revocation clears material and
 * surfaces a typed login-required error.
 */
export class AuthenticatedHttpClient {
  readonly #options: AuthenticatedHttpClientOptions

  constructor(options: AuthenticatedHttpClientOptions) {
    this.#options = options
  }

  async request(request: AuthenticatedRequest): Promise<AuthenticatedFetchResult> {
    const credential = await this.#options.tokens.getValidCredential(request.signal)
    const usedToken = credential.accessToken
    let result = await this.#send(request, usedToken)
    if (result.response.status === 401) {
      const token = await this.#recover(usedToken, request.signal)
      if (IDEMPOTENT_METHODS.has(request.method.toUpperCase())) {
        result = await this.#send(request, token)
        if (result.response.status === 401) {
          await this.#options.tokens.clear()
          throw new LoginRequiredError()
        }
      }
    }
    return result
  }

  async #recover(usedToken: string, signal: AbortSignal | undefined): Promise<string> {
    const current = await this.#options.tokens.read()
    if (current === null) throw new LoginRequiredError()
    // Another concurrent 401 may already have rotated the token; reuse it
    // rather than starting a second refresh.
    if (current.accessToken !== usedToken) return current.accessToken
    const refreshed = await this.#options.tokens.refresh(signal)
    return refreshed.accessToken
  }

  async #send(request: AuthenticatedRequest, token: string): Promise<AuthenticatedFetchResult> {
    const headers: Record<string, string> = { ...(request.headers ?? {}) }
    // Header ownership: remove every caller-supplied spelling of the managed
    // headers before writing the canonical ones. Keeping a second casing would
    // make undici merge both values into one combined header on the wire
    // (e.g. `Authorization: attacker, Bearer <token>`).
    deleteOwnedHeader(headers, 'authorization')
    deleteOwnedHeader(headers, 'idempotency-key')
    headers['authorization'] = `Bearer ${token}`
    if (request.idempotencyKey !== undefined) {
      headers['idempotency-key'] = request.idempotencyKey
    }
    const timeout = withTimeout(request.signal, this.#options.timeoutMilliseconds)
    try {
      const response = await this.#options.fetch(request.url, {
        headers,
        method: request.method,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: timeout.signal,
      })
      return {
        requestId: response.headers.get('x-request-id'),
        response,
        retryAfterSeconds: retryAfterSecondsOf(response),
      }
    } catch (error) {
      if (error instanceof OcboxError) throw error
      throw timeout.didTimeout()
        ? new OcboxError({
            code: 'PROVIDER_TIMEOUT',
            message: 'The hosted service did not respond in time',
            requestId: newRequestId(),
          })
        : new OcboxError({
            code: 'PROVIDER_UNAVAILABLE',
            message: 'The hosted service could not be reached',
            requestId: newRequestId(),
          })
    } finally {
      timeout.dispose()
    }
  }
}

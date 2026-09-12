import { OcboxError } from '../errors/index.js'
import { normalizeIssuer } from './config.js'
import { AuthBindingError, LoginRequiredError, newRequestId } from './errors.js'
import type { FetchPort } from './ports.js'
import type { HostedTokenManager } from './token-manager.js'

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE'])
/**
 * The pinned contract constrains `Idempotency-Key` to 1-128 characters from
 * `[A-Za-z0-9._:-]` (`components.parameters.IdempotencyKey`). A key outside
 * that shape cannot justify a replay/refresh and must never reach the wire.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

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
  /**
   * Certified API base the bearer credential was minted for (derived from the
   * configured hosted endpoints). Mandatory: without it a direct constructor
   * could attach the bearer to any URL. The value is validated like the issuer
   * (absolute uncredentialed http(s), no query/fragment, https off-loopback)
   * and every request URL is refused unless it resolves to the configured
   * origin and normalized base-path subtree. The path check prevents a bearer
   * minted for a subpath deployment from reaching a same-origin sibling app.
   */
  readonly apiOrigin: string
}

function assertContractIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new TypeError('The idempotency key must be 1-128 characters from [A-Za-z0-9._:-]')
  }
}

/** Validates and canonicalizes the configured API base before any token read. */
function certifiedApiBase(apiOrigin: string): URL {
  return new URL(normalizeIssuer(apiOrigin))
}

/**
 * Resolves the wire target and binds it to the certified API origin. Requests
 * must be absolute http(s), uncredentialed, fragment-free, and aimed at exactly
 * the configured origin; otherwise the bearer credential would be sent to an
 * unexpected destination.
 */
function requestTargetOf(request: Pick<AuthenticatedRequest, 'url'>, apiBase: URL): URL {
  let url: URL
  try {
    url = request.url instanceof URL ? request.url : new URL(String(request.url))
  } catch {
    throw new TypeError('The request URL must be an absolute URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('The request URL must use http or https')
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('The request URL must not embed credentials')
  }
  if (url.hash !== '') {
    throw new TypeError('The request URL must not include a fragment')
  }
  if (url.origin !== apiBase.origin) {
    throw new AuthBindingError(
      undefined,
      'The request destination is not the configured hosted API; ' +
        're-run `ocbox auth login` with the matching --api-url',
    )
  }
  // URL parsing canonicalizes dot segments before this boundary check. A root
  // deployment binds by origin; a subpath deployment also binds the bearer to
  // that exact path segment or one of its descendants.
  const prefix = apiBase.pathname.replace(/\/+$/, '')
  if (prefix !== '' && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
    throw new AuthBindingError(
      undefined,
      'The request destination is not under the configured hosted API base; ' +
        're-run `ocbox auth login` with the matching --api-url',
    )
  }
  return url
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

/**
 * Attaches access tokens only as `Authorization: Bearer`, and only to the
 * configured API origin. Eligibility for rotation and the single retry is
 * derived before any rotation happens: refresh happens exactly when the
 * request could be safely replayed (idempotent/safe methods, or any method
 * carrying a contract-valid idempotency key), and a repeatedly-401ing request
 * clears local material only when no concurrent actor has rotated it since.
 * Redirects are never followed, so bearer material cannot leak to an alternate
 * destination. Refresh reuse or revocation clears material and surfaces a
 * typed login-required error. Caller cancellation and transport timeouts are
 * reported distinctly (`OPERATION_CANCELLED` vs `PROVIDER_TIMEOUT`).
 */
export class AuthenticatedHttpClient {
  readonly #options: AuthenticatedHttpClientOptions
  readonly #apiBase: URL

  constructor(options: AuthenticatedHttpClientOptions) {
    this.#options = options
    this.#apiBase = certifiedApiBase(options.apiOrigin)
  }

  async request(request: AuthenticatedRequest): Promise<AuthenticatedFetchResult> {
    // Reject a non-contract idempotency key before it can authorize a retry.
    if (request.idempotencyKey !== undefined) {
      assertContractIdempotencyKey(request.idempotencyKey)
    }
    // Destination binding happens before any credential is read from the store.
    const target = requestTargetOf(request, this.#apiBase)
    const credential = await this.#options.tokens.getValidCredential(request.signal)
    const usedToken = credential.accessToken
    let result = await this.#send(request, target, usedToken)
    // Rotation plus the retry is only justified when the request is safe to
    // replay: idempotent methods, or any method carrying a contract idempotency
    // key. Derived once, before any rotation, so a non-replayable request never
    // burns a refresh family unnecessarily.
    const replayable =
      IDEMPOTENT_METHODS.has(request.method.toUpperCase()) || request.idempotencyKey !== undefined
    if (result.response.status === 401 && replayable) {
      const token = await this.#recover(usedToken, request.signal)
      result = await this.#send(request, target, token)
      if (result.response.status === 401) {
        const cleared = await this.#options.tokens.clearIfToken(token)
        if (cleared) throw new LoginRequiredError()
        // A concurrent actor rotated to a newer credential while we were
        // retrying; keep it (it may be valid) and surface the 401 truthfully.
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
    // The rotation is forced only while the store still holds the rejected
    // token; a generation another process already rotated to is adopted as-is.
    const refreshed = await this.#options.tokens.refresh({
      rejectedAccessToken: usedToken,
      ...(signal === undefined ? {} : { signal }),
    })
    return refreshed.accessToken
  }

  async #send(
    request: AuthenticatedRequest,
    target: URL,
    token: string,
  ): Promise<AuthenticatedFetchResult> {
    const headers: Record<string, string> = { ...(request.headers ?? {}) }
    // Header ownership: remove every caller-supplied spelling of the managed
    // headers before writing the canonical ones. Keeping a second casing would
    // make undici merge both values into one combined header on the wire
    // (e.g. `Authorization: attacker, Bearer <token>`).
    deleteOwnedHeader(headers, 'authorization')
    deleteOwnedHeader(headers, 'idempotency-key')
    // Index-signature access is required by the Record type; biome's
    // useLiteralKeys suggestion conflicts with the TS4111 compiler rule here.
    // biome-ignore lint/complexity/useLiteralKeys: Record index signature access
    headers['authorization'] = `Bearer ${token}`
    if (request.idempotencyKey !== undefined) {
      headers['idempotency-key'] = request.idempotencyKey
    }
    const timeout = withTimeout(request.signal, this.#options.timeoutMilliseconds)
    try {
      const response = await this.#options.fetch(target, {
        headers,
        method: request.method,
        // Redirects are never followed: the bearer credential travels only to
        // the exact caller-provided, origin-bound target.
        redirect: 'manual',
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: timeout.signal,
      })
      if (response.status >= 300 && response.status < 400) {
        throw new OcboxError({
          code: 'PROVIDER_AUTH',
          message: 'The hosted service returned an unexpected redirect',
          requestId: newRequestId(),
        })
      }
      return {
        requestId: response.headers.get('x-request-id'),
        response,
        retryAfterSeconds: retryAfterSecondsOf(response),
      }
    } catch (error) {
      if (error instanceof OcboxError) throw error
      throw this.#transportError(timeout)
    } finally {
      timeout.dispose()
    }
  }

  #transportError(timeout: TimeoutSignal): OcboxError {
    if (timeout.didTimeout()) {
      return new OcboxError({
        code: 'PROVIDER_TIMEOUT',
        message: 'The hosted service did not respond in time',
        requestId: newRequestId(),
      })
    }
    if (timeout.didCancel()) {
      return new OcboxError({
        code: 'OPERATION_CANCELLED',
        message: 'The hosted service request was cancelled',
        requestId: newRequestId(),
      })
    }
    return new OcboxError({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'The hosted service could not be reached',
      requestId: newRequestId(),
    })
  }
}

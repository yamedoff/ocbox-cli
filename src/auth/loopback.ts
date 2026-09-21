import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OcboxError } from '../errors/index.js'
import { LOOPBACK_HOST, LOOPBACK_PATH } from './config.js'
import { newRequestId } from './errors.js'
import { timingSafeEqualText } from './pkce.js'

// Authorization codes are pinned by the hosted contract schema: 32-256 chars
// of unreserved base64url alphabet.
const CODE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/
const MAX_REQUEST_TARGET_LENGTH = 2_048
// Security-relevant callback parameters: any duplicated occurrence leaves
// which copy governs undefined, so the request is refused before parsing.
const CALLBACK_SECURITY_PARAMETERS = [
  'client_id',
  'code',
  'code_challenge',
  'error',
  'error_description',
  'error_uri',
  'iss',
  'state',
] as const

const SUCCESS_BODY =
  '<!doctype html><meta charset="utf-8"><title>OpenCloudBox</title><p>Authorization complete. You may close this window.</p>'
const FAILURE_BODY =
  '<!doctype html><meta charset="utf-8"><title>OpenCloudBox</title><p>Authorization could not be completed.</p>'

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

export interface AuthorizationCallback {
  readonly code: string
}

export interface LoopbackListener {
  readonly redirectUri: string
  /** Resolves with the single accepted authorization code. */
  waitForCallback(signal?: AbortSignal): Promise<AuthorizationCallback>
  /** Idempotently stops listening and releases the ephemeral port. */
  close(): Promise<void>
}

export interface LoopbackListenerInput {
  readonly expectedState: string
  readonly timeoutMilliseconds: number
}

export type LoopbackListenerFactory = (input: LoopbackListenerInput) => Promise<LoopbackListener>

function authError(message: string): OcboxError {
  return new OcboxError({ code: 'AUTH_REQUIRED', message, requestId: newRequestId() })
}

/** Loopback-only OAuth callback server for one short-lived authorization code. */
export class LoopbackCallbackListener implements LoopbackListener {
  readonly #server: Server
  readonly #expectedState: string
  readonly #path: string
  readonly #host: string
  readonly #timeoutMilliseconds: number
  #port = 0
  #settled = false
  #accepted = false
  #pending: AuthorizationCallback | null = null
  #failure: unknown = null
  #waitPromise: Promise<AuthorizationCallback> | null = null
  #resolve: ((callback: AuthorizationCallback) => void) | null = null
  #reject: ((error: unknown) => void) | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #closePromise: Promise<void> | null = null
  #abortSignal: AbortSignal | null = null
  readonly #onAbort = (): void => {
    void this.#fail(authError('Login was cancelled'))
  }

  constructor(input: LoopbackListenerInput) {
    this.#server = createServer((request, response) => {
      this.#handle(request, response)
    })
    this.#server.on('clientError', (_error, socket) => {
      socket.destroy()
    })
    this.#expectedState = input.expectedState
    this.#path = LOOPBACK_PATH
    this.#host = LOOPBACK_HOST
    this.#timeoutMilliseconds = input.timeoutMilliseconds
  }

  get redirectUri(): string {
    return `http://${this.#host}:${this.#port}${this.#path}`
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.#server.removeListener('error', onError)
        resolve()
      }
      this.#server.once('error', onError)
      this.#server.once('listening', onListening)
      this.#server.listen({ host: this.#host, port: 0 })
    })
    const address = this.#server.address() as AddressInfo | null
    if (address === null || typeof address === 'string' || address.address !== this.#host) {
      await this.close()
      throw new Error('Loopback listener did not bind to the requested host')
    }
    this.#port = address.port
  }

  waitForCallback(signal?: AbortSignal): Promise<AuthorizationCallback> {
    if (this.#waitPromise !== null) return this.#waitPromise
    if (this.#pending !== null) {
      this.#waitPromise = Promise.resolve(this.#pending)
      return this.#waitPromise
    }
    if (this.#settled) {
      this.#waitPromise = Promise.reject(this.#failure ?? authError('Login was cancelled'))
      return this.#waitPromise
    }
    this.#waitPromise = new Promise<AuthorizationCallback>((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
      this.#timer = setTimeout(() => {
        void this.#fail(authError('Authorization timed out; run `ocbox auth login` again'))
      }, this.#timeoutMilliseconds)
      this.#timer.unref?.()
      if (signal !== undefined) {
        this.#abortSignal = signal
        if (signal.aborted) this.#onAbort()
        else signal.addEventListener('abort', this.#onAbort, { once: true })
      }
    })
    return this.#waitPromise
  }

  async close(): Promise<void> {
    if (!this.#settled) this.#fail(authError('Login was cancelled'))
    return this.#closeServer()
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    // After the single accepted callback every later request is refused and
    // can never re-resolve the flow.
    if (this.#settled || this.#accepted) {
      respond(response, 409, FAILURE_BODY)
      return
    }
    if (request.method !== 'GET') {
      respond(response, 405, FAILURE_BODY)
      return
    }
    const expectedHost = `${this.#host}:${this.#port}`
    if (request.headers.host !== expectedHost) {
      // Guards against DNS-rebinding: the Host header must name the exact
      // loopback authority regardless of which name resolved to 127.0.0.1.
      respond(response, 400, FAILURE_BODY)
      return
    }
    const target = request.url ?? ''
    if (target.length === 0 || target.length > MAX_REQUEST_TARGET_LENGTH) {
      respond(response, 400, FAILURE_BODY)
      return
    }
    let url: URL
    try {
      url = new URL(target, `http://${expectedHost}`)
    } catch {
      respond(response, 400, FAILURE_BODY)
      return
    }
    if (url.pathname !== this.#path) {
      respond(response, 404, FAILURE_BODY)
      return
    }

    const state = url.searchParams.get('state') ?? ''
    const providerError = url.searchParams.get('error')
    // Ambiguous shapes are refused: an authorization endpoint must emit each
    // security parameter exactly once, duplicated values would leave which
    // copy governs undefined behavior, and success/error parameters must never
    // coexist on one callback.
    for (const parameter of CALLBACK_SECURITY_PARAMETERS) {
      if (url.searchParams.getAll(parameter).length > 1) {
        respond(response, 400, FAILURE_BODY)
        return
      }
    }
    if (providerError !== null && url.searchParams.get('code') !== null) {
      // A callback carrying both `code` and `error` cannot be classified; the
      // authorization server must send exactly one outcome.
      respond(response, 400, FAILURE_BODY)
      return
    }
    if (providerError !== null) {
      if (!timingSafeEqualText(state, this.#expectedState)) {
        respond(response, 400, FAILURE_BODY)
        return
      }
      respond(response, 200, FAILURE_BODY)
      this.#fail(authError('Authorization was not granted'))
      return
    }

    if (url.searchParams.get('code') === null) {
      respond(response, 400, FAILURE_BODY)
      return
    }
    const code = url.searchParams.get('code') ?? ''
    if (!timingSafeEqualText(state, this.#expectedState)) {
      respond(response, 400, FAILURE_BODY)
      return
    }
    if (!CODE_PATTERN.test(code)) {
      respond(response, 400, FAILURE_BODY)
      return
    }

    this.#accepted = true
    this.#settled = true
    this.#pending = { code }
    this.#detachAbort()
    if (this.#timer !== null) clearTimeout(this.#timer)
    respond(response, 200, SUCCESS_BODY)
    this.#resolve?.(this.#pending)
  }

  #fail(error: unknown): void {
    if (this.#settled) return
    this.#settled = true
    this.#failure = error
    this.#detachAbort()
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#reject?.(error)
    void this.#closeServer()
  }

  #detachAbort(): void {
    if (this.#abortSignal !== null) {
      this.#abortSignal.removeEventListener('abort', this.#onAbort)
      this.#abortSignal = null
    }
  }

  #closeServer(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise
    this.#closePromise = new Promise<void>((resolve) => {
      if (!this.#server.listening) {
        resolve()
        return
      }
      this.#server.close(() => resolve())
      // Keep-alive sockets can keep the ephemeral port open after `close`.
      this.#server.closeIdleConnections()
    })
    return this.#closePromise
  }
}

/** Binds a single-use callback listener to `127.0.0.1` on an OS-chosen port. */
export const startLoopbackListener: LoopbackListenerFactory = async (input) => {
  const listener = new LoopbackCallbackListener(input)
  await listener.start()
  return listener
}

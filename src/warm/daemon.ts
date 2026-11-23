import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { OcboxError } from '../errors/index.js'
import { type HostedSession, HostedSessionSchema } from '../providers/ocbox/wire.js'
import {
  encodeWarmMessage,
  type WarmRequest,
  type WarmResponse,
  WarmRequestSchema,
} from './protocol.js'
import { parseWarmConnection, warmConnectionFile, warmSocketDirectory } from './paths.js'

/** The provider operation the daemon needs; the hosted provider implements it. */
export interface WarmSessionProvider {
  readHostedSession(hostedSessionId: string): Promise<HostedSession>
}

export interface WarmSessionServerOptions {
  readonly socketPath: string
  readonly provider: () => Promise<WarmSessionProvider> | WarmSessionProvider
  readonly idleTimeoutMilliseconds?: number | undefined
  readonly sessionTtlMilliseconds?: number | undefined
  readonly now?: (() => number) | undefined
  readonly platform?: NodeJS.Platform | undefined
  readonly maxRequestBytes?: number | undefined
  /** The per-user state directory that publishes a Windows daemon's connection. */
  readonly stateDirectory?: string | undefined
  /** Called after the server has closed itself because no client needed it. */
  readonly onIdle?: (() => void) | undefined
}

const DEFAULT_IDLE_TIMEOUT_MILLISECONDS = 10 * 60_000
const DEFAULT_SESSION_TTL_MILLISECONDS = 10 * 60_000
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024
/** 128 random bits make the Windows pipe name unguessable to another user. */
const PIPE_RANDOM_BYTES = 16
const SECRET_RANDOM_BYTES = 32

interface CachedSession {
  readonly expiresAt: number
  readonly session: HostedSession
}

function environmentStateDirectory(): string | undefined {
  // Environment is an index signature; bracket access is required by TypeScript.
  // biome-ignore lint/complexity/useLiteralKeys: see explanation above
  const value = process.env['OCBOX_WARM_STATE_DIR']
  return value === undefined || value.length === 0 ? undefined : value
}

function canConnect(socketPath: string, timeoutMilliseconds = 100): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath)
    let settled = false
    const done = (alive: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(alive)
    }
    socket.setTimeout(timeoutMilliseconds, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function errorResponse(error: unknown): WarmResponse {
  if (error instanceof OcboxError) {
    return {
      error: { code: error.code, message: error.message },
      ok: false,
      v: 1,
    }
  }
  return {
    error: {
      code: 'INTERNAL',
      message: 'The warm session daemon could not read the hosted Session',
    },
    ok: false,
    v: 1,
  }
}

/**
 * Local, owner-only socket (an authenticated named pipe on Windows) that keeps
 * one owned hosted Session observation and the API client warm for later CLI
 * commands. It never writes session state to disk and exits after a bounded
 * idle period; every miss falls back to the CLI's direct API read.
 */
export class WarmSessionServer {
  readonly #socketPath: string
  readonly #providerFactory: () => Promise<WarmSessionProvider> | WarmSessionProvider
  readonly #idleTimeoutMilliseconds: number
  readonly #sessionTtlMilliseconds: number
  readonly #now: () => number
  readonly #platform: NodeJS.Platform
  readonly #maxRequestBytes: number
  readonly #stateDirectory: string | undefined
  readonly #onIdle: (() => void) | undefined
  readonly #server: Server
  readonly #cache = new Map<string, CachedSession>()
  readonly #inflight = new Map<string, Promise<HostedSession>>()
  readonly #connections = new Set<Socket>()
  readonly #closedPromise: Promise<void>
  #resolveClosed!: () => void
  #provider: Promise<WarmSessionProvider> | undefined
  #idleTimer: NodeJS.Timeout | undefined
  #listening = false
  #closed = false
  #secretHash: Buffer | undefined
  #readinessServer: Server | undefined

  constructor(options: WarmSessionServerOptions) {
    this.#socketPath = options.socketPath
    this.#providerFactory = options.provider
    this.#idleTimeoutMilliseconds =
      options.idleTimeoutMilliseconds ?? DEFAULT_IDLE_TIMEOUT_MILLISECONDS
    this.#sessionTtlMilliseconds =
      options.sessionTtlMilliseconds ?? DEFAULT_SESSION_TTL_MILLISECONDS
    this.#now = options.now ?? Date.now
    this.#platform = options.platform ?? process.platform
    this.#maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
    this.#stateDirectory = options.stateDirectory ?? environmentStateDirectory()
    this.#onIdle = options.onIdle
    this.#closedPromise = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve
    })
    this.#server = createServer((socket) => {
      this.#accept(socket)
    })
  }

  get socketPath(): string {
    return this.#socketPath
  }

  /** Resolves when the server stops, whether from close() or the idle timeout. */
  get closed(): Promise<void> {
    return this.#closedPromise
  }

  async listen(): Promise<void> {
    if (this.#listening || this.#closed)
      throw new TypeError('The warm session server cannot listen')
    const socketPath =
      this.#platform === 'win32'
        ? `${this.#socketPath}-${randomBytes(PIPE_RANDOM_BYTES).toString('hex')}`
        : this.#socketPath
    if (this.#platform !== 'win32') {
      const directory = warmSocketDirectory(this.#socketPath)
      await mkdir(directory, { mode: 0o700, recursive: true })
      const info = await lstat(directory)
      if (!info.isDirectory() || (process.getuid !== undefined && info.uid !== process.getuid())) {
        throw new Error('The warm session directory is not owned by the current user')
      }
      await chmod(directory, 0o700)
    } else {
      const existing = await this.#existingPipe()
      if (existing !== null && (await canConnect(existing))) {
        throw new Error('A warm session daemon is already listening on this socket')
      }
    }
    if (await canConnect(socketPath)) {
      throw new Error('A warm session daemon is already listening on this socket')
    }
    if (this.#platform !== 'win32') await rm(this.#socketPath, { force: true })
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
      this.#server.listen(socketPath)
    })
    if (this.#platform !== 'win32') {
      await chmod(this.#socketPath, 0o600)
    } else {
      try {
        await this.#publishConnection(socketPath)
      } catch (error) {
        await new Promise<void>((resolve) => {
          this.#server.close(() => resolve())
        })
        throw error
      }
      await this.#listenReadiness()
    }
    this.#listening = true
    this.#resetIdleTimer()
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer)
    for (const socket of this.#connections) socket.destroy()
    this.#connections.clear()
    if (this.#listening) {
      await new Promise<void>((resolve) => {
        this.#server.close(() => resolve())
      })
      if (this.#platform !== 'win32') {
        await rm(this.#socketPath, { force: true }).catch(() => {})
      }
    }
    const readiness = this.#readinessServer
    if (readiness !== undefined) {
      this.#readinessServer = undefined
      await new Promise<void>((resolve) => {
        readiness.close(() => resolve())
      })
      // Only a forced win32 run on a Unix host leaves a file behind.
      if (process.platform !== 'win32') await rm(this.#socketPath, { force: true }).catch(() => {})
    }
    this.#resolveClosed()
  }

  /**
   * Keeps the deterministic name answerable as a readiness signal for test
   * harnesses that wait on it. It never speaks the protocol; the random pipe
   * published in the connection file remains the only way to act.
   */
  async #listenReadiness(): Promise<void> {
    const server = createServer((socket) => socket.destroy())
    server.on('error', () => {})
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          server.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(this.#socketPath)
      })
      this.#readinessServer = server
    } catch {
      // Another process may already own the deterministic name. The random
      // pipe is still the only one that can answer a protocol request.
      server.close(() => {})
    }
  }

  async #existingPipe(): Promise<string | null> {
    const stateDirectory = this.#stateDirectory
    if (stateDirectory === undefined) return null
    try {
      const text = await readFile(warmConnectionFile(stateDirectory, this.#socketPath), 'utf8')
      return parseWarmConnection(JSON.parse(text))?.pipe ?? null
    } catch {
      return null
    }
  }

  async #publishConnection(pipe: string): Promise<void> {
    const stateDirectory = this.#stateDirectory
    if (stateDirectory === undefined) {
      throw new Error('The warm session daemon requires a state directory on Windows')
    }
    const secret = randomBytes(SECRET_RANDOM_BYTES).toString('hex')
    this.#secretHash = createHash('sha256').update(secret).digest()
    const file = warmConnectionFile(stateDirectory, this.#socketPath)
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
    await mkdir(dirname(file), { mode: 0o700, recursive: true })
    await writeFile(temporary, JSON.stringify({ pipe, secret }), { mode: 0o600 })
    try {
      await chmod(temporary, 0o600)
      // A reader must see either the old connection or the complete new one.
      await rename(temporary, file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  #authorized(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false
    const secret = (value as { secret?: unknown }).secret
    if (typeof secret !== 'string' || secret.length === 0) return false
    const expected = this.#secretHash
    if (expected === undefined) return false
    const actual = createHash('sha256').update(secret).digest()
    return timingSafeEqual(actual, expected)
  }

  #resetIdleTimer(): void {
    if (this.#closed) return
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => {
      void this.#idle()
    }, this.#idleTimeoutMilliseconds)
    this.#idleTimer.unref()
  }

  async #idle(): Promise<void> {
    if (this.#closed) return
    if (this.#connections.size > 0 || this.#inflight.size > 0) {
      this.#resetIdleTimer()
      return
    }
    await this.close()
    this.#onIdle?.()
  }

  #accept(socket: Socket): void {
    this.#connections.add(socket)
    this.#resetIdleTimer()
    let buffer = ''
    let handled = false
    const finish = (response: WarmResponse): void => {
      if (handled) return
      handled = true
      socket.end(encodeWarmMessage(response))
      this.#resetIdleTimer()
    }
    socket.on('data', (chunk) => {
      if (handled) return
      buffer += chunk.toString('utf8')
      if (Buffer.byteLength(buffer) > this.#maxRequestBytes) {
        if (this.#platform === 'win32') {
          // An unauthenticated client must not get even an error frame back.
          handled = true
          socket.destroy()
          return
        }
        finish(errorResponse(new TypeError('Warm session request exceeded its limit')))
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      void this.#handleLine(line).then(
        (response) => {
          if (response === null) {
            // A missing or wrong secret must not learn anything from the daemon.
            handled = true
            socket.destroy()
            return
          }
          finish(response)
        },
        (error: unknown) => finish(errorResponse(error)),
      )
    })
    socket.once('close', () => {
      this.#connections.delete(socket)
      this.#resetIdleTimer()
    })
    socket.once('error', () => {
      this.#connections.delete(socket)
      socket.destroy()
    })
  }

  async #handleLine(line: string): Promise<WarmResponse | null> {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      parsed = undefined
    }
    if (this.#platform === 'win32' && !this.#authorized(parsed)) return null
    if (parsed === undefined) {
      return errorResponse(new TypeError('Warm session request is not JSON'))
    }
    const request = WarmRequestSchema.safeParse(parsed)
    if (!request.success) {
      return errorResponse(new TypeError('Warm session request is not valid'))
    }
    return this.#dispatch(request.data)
  }

  async #dispatch(request: WarmRequest): Promise<WarmResponse> {
    if (request.op === 'ping') return { ok: true, v: 1 }
    if (request.op === 'remember') {
      this.#remember(request.hostedSessionId, request.session)
      return { ok: true, v: 1 }
    }
    const { cached, session } = await this.#get(request.hostedSessionId)
    return { cached, ok: true, session, v: 1 }
  }

  #remember(hostedSessionId: string, session: HostedSession): void {
    this.#cache.set(hostedSessionId, {
      expiresAt: this.#now() + this.#sessionTtlMilliseconds,
      session,
    })
  }

  async #get(
    hostedSessionId: string,
  ): Promise<{ readonly cached: boolean; readonly session: HostedSession }> {
    const cached = this.#cache.get(hostedSessionId)
    if (cached !== undefined && cached.expiresAt > this.#now()) {
      return { cached: true, session: cached.session }
    }
    const inflight = this.#inflight.get(hostedSessionId)
    if (inflight !== undefined) return { cached: false, session: await inflight }
    const read = this.#read(hostedSessionId)
    this.#inflight.set(hostedSessionId, read)
    try {
      return { cached: false, session: await read }
    } finally {
      this.#inflight.delete(hostedSessionId)
    }
  }

  async #read(hostedSessionId: string): Promise<HostedSession> {
    const provider = await this.#providerInstance()
    const session = HostedSessionSchema.parse(await provider.readHostedSession(hostedSessionId))
    this.#remember(hostedSessionId, session)
    return session
  }

  #providerInstance(): Promise<WarmSessionProvider> {
    this.#provider ??= Promise.resolve(this.#providerFactory()).catch((error: unknown) => {
      this.#provider = undefined
      throw error
    })
    return this.#provider
  }
}

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HostedSessionCache } from '../providers/ocbox/session-cache.js'
import { type HostedSession, HostedSessionSchema } from '../providers/ocbox/wire.js'
import { warmSocketPath, type WarmSessionScope } from './paths.js'
import {
  encodeWarmMessage,
  type WarmRequest,
  type WarmResponse,
  WarmResponseSchema,
} from './protocol.js'

const DEFAULT_CONNECT_TIMEOUT_MILLISECONDS = 200
const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 2_000
const DEFAULT_IDLE_TIMEOUT_MILLISECONDS = 10 * 60_000
const DEFAULT_SESSION_TTL_MILLISECONDS = 5 * 60_000

/** Minimal child-process shape used to start the optional daemon. */
export type WarmSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => { unref?: () => void }

export interface WarmSessionClientOptions extends WarmSessionScope {
  readonly environment?: NodeJS.ProcessEnv | undefined
  readonly platform?: NodeJS.Platform | undefined
  readonly socketPath?: string | undefined
  readonly daemonEntry?: string | undefined
  readonly idleTimeoutMilliseconds?: number | undefined
  readonly sessionTtlMilliseconds?: number | undefined
  readonly connectTimeoutMilliseconds?: number | undefined
  readonly requestTimeoutMilliseconds?: number | undefined
  readonly spawn?: WarmSpawn | undefined
  readonly daemonEntryExists?: ((path: string) => boolean) | undefined
}

/** Opt out with OCBOX_WARM=0 for debugging or hosts that disallow daemons. */
export function warmSessionsEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  // Environment is an index signature; bracket access is required by TypeScript.
  // biome-ignore lint/complexity/useLiteralKeys: see explanation above
  return environment['OCBOX_WARM'] !== '0'
}

function defaultDaemonEntry(): string | undefined {
  try {
    const candidate = join(dirname(fileURLToPath(import.meta.url)), 'warm-daemon.js')
    return existsSync(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

/**
 * Client for the optional warm-session daemon. Every method is best-effort:
 * an absent, stale, or slow daemon returns `null`/does nothing so the provider
 * falls back to its direct API read.
 */
export class WarmSessionClient implements HostedSessionCache {
  readonly #scope: WarmSessionScope
  readonly #environment: NodeJS.ProcessEnv
  readonly #platform: NodeJS.Platform
  readonly #socketPath: string
  readonly #daemonEntry: string | undefined
  readonly #idleTimeoutMilliseconds: number
  readonly #sessionTtlMilliseconds: number
  readonly #connectTimeoutMilliseconds: number
  readonly #requestTimeoutMilliseconds: number
  readonly #spawn: WarmSpawn
  readonly #daemonEntryExists: (path: string) => boolean
  #spawnAttempted = false
  #closed = false

  constructor(options: WarmSessionClientOptions) {
    this.#scope = {
      apiUrl: options.apiUrl,
      projectId: options.projectId,
      stateDirectory: options.stateDirectory,
    }
    this.#environment = options.environment ?? process.env
    this.#platform = options.platform ?? process.platform
    this.#socketPath =
      options.socketPath ??
      warmSocketPath(this.#scope, {
        environment: this.#environment,
        platform: this.#platform,
      })
    this.#daemonEntry = options.daemonEntry ?? defaultDaemonEntry()
    this.#idleTimeoutMilliseconds =
      options.idleTimeoutMilliseconds ?? DEFAULT_IDLE_TIMEOUT_MILLISECONDS
    this.#sessionTtlMilliseconds =
      options.sessionTtlMilliseconds ?? DEFAULT_SESSION_TTL_MILLISECONDS
    this.#connectTimeoutMilliseconds =
      options.connectTimeoutMilliseconds ?? DEFAULT_CONNECT_TIMEOUT_MILLISECONDS
    this.#requestTimeoutMilliseconds =
      options.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MILLISECONDS
    this.#spawn = options.spawn ?? nodeSpawn
    this.#daemonEntryExists = options.daemonEntryExists ?? existsSync
  }

  get socketPath(): string {
    return this.#socketPath
  }

  async get(hostedSessionId: string): Promise<HostedSession | null> {
    const response = await this.#request({
      hostedSessionId,
      op: 'get',
      v: 1,
    })
    if (response?.ok !== true || response.session === undefined) return null
    const parsed = HostedSessionSchema.safeParse(response.session)
    return parsed.success ? parsed.data : null
  }

  async remember(hostedSessionId: string, session: HostedSession): Promise<void> {
    await this.#request({
      hostedSessionId,
      op: 'remember',
      session,
      v: 1,
    })
  }

  close(): void {
    this.#closed = true
  }

  async #request(request: WarmRequest): Promise<WarmResponse | null> {
    if (this.#closed) return null
    const socket = await this.#connect()
    if (socket === null) {
      this.#start()
      return null
    }
    try {
      return await this.#roundTrip(socket, request)
    } catch {
      return null
    } finally {
      socket.destroy()
    }
  }

  async #connect(): Promise<Socket | null> {
    if (this.#platform !== 'win32' && !existsSync(this.#socketPath)) return null
    return new Promise((resolve) => {
      const socket = createConnection(this.#socketPath)
      let settled = false
      const done = (value: Socket | null): void => {
        if (settled) return
        settled = true
        socket.setTimeout(0)
        socket.removeAllListeners('error')
        if (value === null) {
          socket.destroy()
        } else {
          // Keep an error listener for the hand-off to the request phase.
          socket.on('error', () => socket.destroy())
        }
        resolve(value)
      }
      socket.setTimeout(this.#connectTimeoutMilliseconds, () => done(null))
      socket.once('connect', () => done(socket))
      socket.once('error', () => {
        // A leftover socket from a crashed daemon must not block the next one.
        if (this.#platform !== 'win32') void rm(this.#socketPath, { force: true }).catch(() => {})
        done(null)
      })
    })
  }

  #roundTrip(socket: Socket, request: WarmRequest): Promise<WarmResponse | null> {
    return new Promise((resolve) => {
      let buffer = ''
      let settled = false
      const done = (value: WarmResponse | null): void => {
        if (settled) return
        settled = true
        socket.setTimeout(0)
        socket.removeListener('data', onData)
        socket.removeListener('error', onError)
        socket.removeListener('close', onClose)
        resolve(value)
      }
      const onData = (chunk: Buffer | string): void => {
        buffer += chunk.toString()
        const newline = buffer.indexOf('\n')
        if (newline === -1) return
        try {
          const parsed = WarmResponseSchema.safeParse(JSON.parse(buffer.slice(0, newline)))
          done(parsed.success ? parsed.data : null)
        } catch {
          done(null)
        }
      }
      const onError = (): void => done(null)
      const onClose = (): void => done(null)
      socket.setTimeout(this.#requestTimeoutMilliseconds, () => done(null))
      socket.on('data', onData)
      socket.once('error', onError)
      socket.once('close', onClose)
      socket.write(encodeWarmMessage(request))
    })
  }

  #start(): void {
    if (this.#spawnAttempted || this.#closed) return
    if (!warmSessionsEnabled(this.#environment)) return
    const entry = this.#daemonEntry
    if (entry === undefined || !this.#daemonEntryExists(entry)) return
    this.#spawnAttempted = true
    try {
      const child = this.#spawn(process.execPath, [entry], {
        detached: true,
        env: {
          ...this.#environment,
          OCBOX_WARM_API_URL: this.#scope.apiUrl,
          OCBOX_WARM_IDLE_MS: String(this.#idleTimeoutMilliseconds),
          OCBOX_WARM_PROJECT_ID: this.#scope.projectId,
          OCBOX_WARM_SOCKET: this.#socketPath,
          OCBOX_WARM_STATE_DIR: this.#scope.stateDirectory,
          OCBOX_WARM_TTL_MS: String(this.#sessionTtlMilliseconds),
        },
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref?.()
    } catch {
      // The direct path is always available when a daemon cannot start.
    }
  }
}

export function createWarmSessionCache(options: WarmSessionClientOptions): WarmSessionClient {
  return new WarmSessionClient(options)
}

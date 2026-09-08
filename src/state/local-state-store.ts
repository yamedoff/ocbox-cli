import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ProjectIdSchema, type ProjectId } from '../domain/ids.js'
import { findSensitiveMaterial } from '../security/redaction.js'
import { ProjectStateSchema, type ProjectState } from './schema.js'

interface LockMetadata {
  readonly pid: number
  readonly createdAtEpochMilliseconds: number
  readonly nonce: string
}

export interface LocalStateStoreOptions {
  readonly lockTimeoutMilliseconds?: number
  readonly staleLockMilliseconds?: number
  readonly pollIntervalMilliseconds?: number
  readonly now?: () => number
  readonly createNonce?: () => string
  readonly processId?: number
  readonly isProcessAlive?: (processId: number) => boolean
}

export class StateLockTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for the project state lock')
    this.name = 'StateLockTimeoutError'
  }
}

export class StateLockCancelledError extends Error {
  constructor() {
    super('Project state lock wait was cancelled')
    this.name = 'StateLockCancelledError'
  }
}

export class StateCorruptionError extends Error {
  readonly quarantineFileName: string

  constructor(quarantineFileName: string) {
    super(`Corrupt project state was quarantined as ${quarantineFileName}`)
    this.name = 'StateCorruptionError'
    this.quarantineFileName = quarantineFileName
  }
}

export class UnsafeStateError extends Error {
  constructor() {
    super('Project state contains material that cannot be persisted')
    this.name = 'UnsafeStateError'
  }
}

function defaultProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    return code === 'EPERM'
  }
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch (error) {
    if (!['EACCES', 'EINVAL', 'EISDIR', 'ENOSYS', 'EPERM'].includes(errorCode(error) ?? '')) {
      throw error
    }
  } finally {
    await handle?.close()
  }
}

/**
 * Atomic JSON state store with a process lock, stale-owner recovery, bounded
 * cancellation-aware contention, and corruption quarantine.
 */
export class LocalStateStore {
  readonly #directory: string
  readonly #lockTimeoutMilliseconds: number
  readonly #staleLockMilliseconds: number
  readonly #pollIntervalMilliseconds: number
  readonly #now: () => number
  readonly #createNonce: () => string
  readonly #processId: number
  readonly #isProcessAlive: (processId: number) => boolean

  constructor(directory: string, options: LocalStateStoreOptions = {}) {
    if (!isAbsolute(directory)) throw new TypeError('Local state directory must be absolute')
    this.#directory = directory
    this.#lockTimeoutMilliseconds = options.lockTimeoutMilliseconds ?? 5_000
    this.#staleLockMilliseconds = options.staleLockMilliseconds ?? 30_000
    this.#pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 25
    this.#now = options.now ?? Date.now
    this.#createNonce = options.createNonce ?? randomUUID
    this.#processId = options.processId ?? process.pid
    this.#isProcessAlive = options.isProcessAlive ?? defaultProcessAlive
  }

  async load(projectId: ProjectId, signal?: AbortSignal): Promise<ProjectState | null> {
    return this.#withLock(projectId, signal, () => this.#readUnderLock(projectId))
  }

  async save(state: ProjectState, signal?: AbortSignal): Promise<void> {
    const parsed = ProjectStateSchema.parse(state)
    if (findSensitiveMaterial(parsed).length > 0) throw new UnsafeStateError()
    await this.#withLock(parsed.projectId, signal, () => this.#writeUnderLock(parsed))
  }

  async update(
    projectId: ProjectId,
    mutate: (current: ProjectState | null) => ProjectState,
    signal?: AbortSignal,
  ): Promise<ProjectState> {
    return this.#withLock(projectId, signal, async () => {
      const current = await this.#readUnderLock(projectId)
      const next = ProjectStateSchema.parse(mutate(current))
      if (next.projectId !== projectId) throw new TypeError('State update changed the Project ID')
      if (findSensitiveMaterial(next).length > 0) throw new UnsafeStateError()
      await this.#writeUnderLock(next)
      return next
    })
  }

  #statePath(projectId: ProjectId): string {
    return join(this.#directory, `${projectId}.json`)
  }

  #lockPath(projectId: ProjectId): string {
    return join(this.#directory, `${projectId}.lock`)
  }

  async #ensureDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(this.#directory, 0o700)
  }

  async #withLock<T>(
    projectId: ProjectId,
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    ProjectIdSchema.parse(projectId)
    await this.#ensureDirectory()
    const lock = await this.#acquireLock(projectId, signal)
    try {
      return await action()
    } finally {
      await this.#releaseLock(lock.path, lock.nonce)
    }
  }

  async #acquireLock(
    projectId: ProjectId,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly path: string; readonly nonce: string }> {
    const path = this.#lockPath(projectId)
    const startedAt = this.#now()

    while (true) {
      if (signal?.aborted === true) throw new StateLockCancelledError()
      const nonce = this.#createNonce()
      const metadata: LockMetadata = {
        pid: this.#processId,
        createdAtEpochMilliseconds: this.#now(),
        nonce,
      }
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(path, 'wx', 0o600)
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        return { path, nonce }
      } catch (error) {
        await handle?.close()
        if (
          errorCode(error) !== 'EEXIST' &&
          !(process.platform === 'win32' && errorCode(error) === 'EPERM')
        )
          throw error
        if (await this.#recoverStaleLock(path)) continue
        if (this.#now() - startedAt >= this.#lockTimeoutMilliseconds) {
          throw new StateLockTimeoutError()
        }
        try {
          await delay(this.#pollIntervalMilliseconds, undefined, { signal })
        } catch {
          throw new StateLockCancelledError()
        }
      }
    }
  }

  async #recoverStaleLock(path: string): Promise<boolean> {
    // Serialize inspection and removal, not just the rename. Otherwise a
    // second reaper can remove a new owner's lock using its stale inspection.
    // If a reaper itself crashes, leave its guard in place and fail closed;
    // an operator can remove that guard once all CLI processes are stopped.
    const guardPath = `${path}.recovery`
    let guard: Awaited<ReturnType<typeof open>>
    try {
      guard = await open(guardPath, 'wx', 0o600)
    } catch (error) {
      if (
        errorCode(error) === 'EEXIST' ||
        (process.platform === 'win32' && errorCode(error) === 'EPERM')
      )
        return false
      throw error
    }
    try {
      return await this.#recoverStaleLockExclusively(path)
    } finally {
      await guard.close()
      await unlink(guardPath)
    }
  }

  async #recoverStaleLockExclusively(path: string): Promise<boolean> {
    let metadata: LockMetadata | undefined
    let lockStat: Awaited<ReturnType<typeof stat>>
    try {
      lockStat = await stat(path)
      const raw = await readFile(path, 'utf8')
      const candidate: unknown = JSON.parse(raw)
      if (
        candidate !== null &&
        typeof candidate === 'object' &&
        'pid' in candidate &&
        'createdAtEpochMilliseconds' in candidate &&
        'nonce' in candidate &&
        typeof candidate.pid === 'number' &&
        Number.isSafeInteger(candidate.pid) &&
        candidate.pid > 0 &&
        typeof candidate.createdAtEpochMilliseconds === 'number' &&
        typeof candidate.nonce === 'string'
      ) {
        metadata = candidate as LockMetadata
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true
      try {
        lockStat = await stat(path)
      } catch (statError) {
        if (errorCode(statError) === 'ENOENT') return true
        throw statError
      }
    }

    const age = this.#now() - lockStat.mtimeMs
    if (age < this.#staleLockMilliseconds) return false
    if (metadata !== undefined && this.#isProcessAlive(metadata.pid)) return false

    const stalePath = `${path}.stale.${this.#createNonce()}`
    try {
      await rename(path, stalePath)
      await rm(stalePath, { force: true })
      return true
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true
      return false
    }
  }

  async #releaseLock(path: string, nonce: string): Promise<void> {
    try {
      const candidate: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (
        candidate !== null &&
        typeof candidate === 'object' &&
        'nonce' in candidate &&
        candidate.nonce === nonce
      ) {
        await unlink(path)
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }

  async #readUnderLock(projectId: ProjectId): Promise<ProjectState | null> {
    const path = this.#statePath(projectId)
    let source: string
    try {
      source = await readFile(path, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null
      throw error
    }

    try {
      const candidate: unknown = JSON.parse(source)
      const parsed = ProjectStateSchema.parse(candidate)
      if (parsed.projectId !== projectId) throw new TypeError('State Project ID mismatch')
      if (findSensitiveMaterial(parsed).length > 0) throw new UnsafeStateError()
      return parsed
    } catch {
      const quarantinePath = `${path}.corrupt.${this.#now()}-${this.#createNonce()}`
      await rename(path, quarantinePath)
      await syncDirectory(this.#directory)
      throw new StateCorruptionError(basename(quarantinePath))
    }
  }

  async #writeUnderLock(state: ProjectState): Promise<void> {
    const destination = this.#statePath(state.projectId)
    const temporary = `${destination}.tmp.${this.#processId}.${this.#createNonce()}`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      if (process.platform !== 'win32') await chmod(temporary, 0o600)
      await rename(temporary, destination)
      await syncDirectory(this.#directory)
    } catch (error) {
      await handle?.close()
      await rm(temporary, { force: true })
      throw error
    }
  }
}

import { randomUUID } from 'node:crypto'
import { chmod, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { type ProjectId, ProjectIdSchema } from '../domain/ids.js'
import { findSensitiveMaterial } from '../security/redaction.js'
import { ExclusiveFileLock, replaceFileAtomically } from './exclusive-file-lock.js'
import { type ProjectState, ProjectStateSchema } from './schema.js'

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
  readonly #lock: ExclusiveFileLock
  readonly #now: () => number
  readonly #createNonce: () => string
  readonly #processId: number

  constructor(directory: string, options: LocalStateStoreOptions = {}) {
    if (!isAbsolute(directory)) throw new TypeError('Local state directory must be absolute')
    this.#directory = directory
    this.#now = options.now ?? Date.now
    this.#createNonce = options.createNonce ?? randomUUID
    this.#processId = options.processId ?? process.pid
    this.#lock = new ExclusiveFileLock({
      now: this.#now,
      createNonce: this.#createNonce,
      processId: this.#processId,
      createTimeoutError: () => new StateLockTimeoutError(),
      createCancelledError: () => new StateLockCancelledError(),
      ...(options.lockTimeoutMilliseconds === undefined
        ? {}
        : { timeoutMilliseconds: options.lockTimeoutMilliseconds }),
      ...(options.staleLockMilliseconds === undefined
        ? {}
        : { staleLockMilliseconds: options.staleLockMilliseconds }),
      ...(options.pollIntervalMilliseconds === undefined
        ? {}
        : { pollIntervalMilliseconds: options.pollIntervalMilliseconds }),
      ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
    })
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

  async #withLock<T>(
    projectId: ProjectId,
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    ProjectIdSchema.parse(projectId)
    return this.#lock.withLock(this.#lockPath(projectId), signal, action)
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
      await replaceFileAtomically(temporary, destination)
      await syncDirectory(this.#directory)
    } catch (error) {
      await handle?.close()
      await rm(temporary, { force: true })
      throw error
    }
  }
}

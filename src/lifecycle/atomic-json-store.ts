import { randomUUID } from 'node:crypto'
import { chmod, open, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { z } from 'zod'
import { ExclusiveFileLock, replaceFileAtomically } from '../state/exclusive-file-lock.js'

export interface AtomicJsonStoreOptions {
  readonly lockWaitMilliseconds?: number
  readonly staleLockMilliseconds?: number
  readonly pollIntervalMilliseconds?: number
  readonly now?: () => number
  readonly createNonce?: () => string
  readonly processId?: number
  readonly isProcessAlive?: (processId: number) => boolean
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error) {
    if (!['EACCES', 'EINVAL', 'EISDIR', 'ENOSYS', 'EPERM'].includes(errorCode(error) ?? '')) {
      throw error
    }
  } finally {
    await handle?.close()
  }
}

export class AtomicStoreConflictError extends Error {
  constructor() {
    super('Another process is updating this state')
    this.name = 'AtomicStoreConflictError'
  }
}

export class AtomicStoreCancelledError extends Error {
  constructor() {
    super('State lock wait was cancelled')
    this.name = 'AtomicStoreCancelledError'
  }
}

/** Schema-validating atomic JSON repository backed by the shared file lock. */
export class AtomicJsonStore<Value> {
  readonly #path: string
  readonly #schema: z.ZodType<Value>
  readonly #lock: ExclusiveFileLock
  readonly #createNonce: () => string
  readonly #processId: number

  constructor(path: string, schema: z.ZodType<Value>, options: AtomicJsonStoreOptions = {}) {
    if (!isAbsolute(path)) throw new TypeError('Atomic JSON store path must be absolute')
    this.#path = path
    this.#schema = schema
    this.#createNonce = options.createNonce ?? randomUUID
    this.#processId = options.processId ?? process.pid
    this.#lock = new ExclusiveFileLock({
      createNonce: this.#createNonce,
      processId: this.#processId,
      createTimeoutError: () => new AtomicStoreConflictError(),
      createCancelledError: () => new AtomicStoreCancelledError(),
      ...(options.lockWaitMilliseconds === undefined
        ? {}
        : { timeoutMilliseconds: options.lockWaitMilliseconds }),
      ...(options.staleLockMilliseconds === undefined
        ? {}
        : { staleLockMilliseconds: options.staleLockMilliseconds }),
      ...(options.pollIntervalMilliseconds === undefined
        ? {}
        : { pollIntervalMilliseconds: options.pollIntervalMilliseconds }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
    })
  }

  /**
   * Reads through the same lock as writes. This prevents Windows readers from
   * transiently holding the destination open during an atomic replacement.
   */
  async load(signal?: AbortSignal): Promise<Value | null> {
    return this.#lock.withLock(`${this.#path}.lock`, signal, () => this.#read())
  }

  async #read(): Promise<Value | null> {
    try {
      return this.#schema.parse(JSON.parse(await readFile(this.#path, 'utf8')))
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null
      throw error
    }
  }

  async update(
    initialize: () => Value,
    mutate: (current: Value) => Value,
    signal?: AbortSignal,
  ): Promise<Value> {
    return this.#lock.withLock(`${this.#path}.lock`, signal, async () => {
      const current = (await this.#read()) ?? this.#schema.parse(initialize())
      const next = this.#schema.parse(mutate(current))
      await this.#write(next)
      return next
    })
  }

  async #write(value: Value): Promise<void> {
    const directory = dirname(this.#path)
    const temporary = `${this.#path}.tmp.${this.#processId}.${this.#createNonce()}`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      if (process.platform !== 'win32') await chmod(temporary, 0o600)
      await replaceFileAtomically(temporary, this.#path)
      await syncDirectory(directory)
    } catch (error) {
      await handle?.close()
      await rm(temporary, { force: true })
      throw error
    }
  }
}

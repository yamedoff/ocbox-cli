import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

interface LockMetadata {
  readonly pid: number
  readonly createdAtEpochMilliseconds: number
  readonly nonce: string
}

type LockAttemptResult =
  | { readonly kind: 'acquired'; readonly nonce: string }
  | { readonly kind: 'contended' }
  | { readonly kind: 'retry' }

export interface ExclusiveFileLockOptions {
  readonly timeoutMilliseconds?: number
  readonly staleLockMilliseconds?: number
  readonly pollIntervalMilliseconds?: number
  readonly now?: () => number
  readonly createNonce?: () => string
  readonly processId?: number
  readonly isProcessAlive?: (processId: number) => boolean
  readonly createTimeoutError: () => Error
  readonly createCancelledError: () => Error
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined
}

function defaultProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

/** Retries Windows sharing violations while retaining atomic rename semantics. */
export async function replaceFileAtomically(source: string, destination: string): Promise<void> {
  // Antivirus scanners and concurrent readers may keep the destination open
  // briefly on Windows. Keep the replacement atomic and retry for a bounded
  // period instead of falling back to delete-and-move.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      const retryable =
        process.platform === 'win32' &&
        ['EACCES', 'EBUSY', 'EPERM'].includes(errorCode(error) ?? '') &&
        attempt < 100
      if (!retryable) throw error
      await delay(Math.min(5 * (attempt + 1), 50))
    }
  }
}

/**
 * Cross-process exclusive file lock with bounded, cancellation-aware waiting.
 * Stale-owner recovery is itself serialized so a reaper cannot remove a newly
 * acquired lock. An abandoned recovery guard deliberately fails closed.
 */
export class ExclusiveFileLock {
  readonly #timeoutMilliseconds: number
  readonly #staleLockMilliseconds: number
  readonly #pollIntervalMilliseconds: number
  readonly #now: () => number
  readonly #createNonce: () => string
  readonly #processId: number
  readonly #isProcessAlive: (processId: number) => boolean
  readonly #createTimeoutError: () => Error
  readonly #createCancelledError: () => Error

  constructor(options: ExclusiveFileLockOptions) {
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 5_000
    this.#staleLockMilliseconds = options.staleLockMilliseconds ?? 30_000
    this.#pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 25
    this.#now = options.now ?? Date.now
    this.#createNonce = options.createNonce ?? randomUUID
    this.#processId = options.processId ?? process.pid
    this.#isProcessAlive = options.isProcessAlive ?? defaultProcessAlive
    this.#createTimeoutError = options.createTimeoutError
    this.#createCancelledError = options.createCancelledError
  }

  async withLock<Result>(
    path: string,
    signal: AbortSignal | undefined,
    action: () => Promise<Result>,
  ): Promise<Result> {
    if (!isAbsolute(path)) throw new TypeError('Lock path must be absolute')
    const directory = dirname(path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(directory, 0o700)
    const nonce = await this.#acquire(path, signal)
    try {
      return await action()
    } finally {
      await this.#release(path, nonce)
    }
  }

  async #acquire(path: string, signal: AbortSignal | undefined): Promise<string> {
    const startedAt = this.#now()
    while (true) {
      if (signal?.aborted === true) throw this.#createCancelledError()
      const attempt = await this.#attemptAcquireUnderRecoveryGuard(path)
      if (attempt.kind === 'acquired') return attempt.nonce
      if (attempt.kind === 'retry') continue
      if (this.#now() - startedAt >= this.#timeoutMilliseconds) {
        throw this.#createTimeoutError()
      }
      try {
        await delay(this.#pollIntervalMilliseconds, undefined, { signal })
      } catch {
        throw this.#createCancelledError()
      }
    }
  }

  async #attemptAcquireUnderRecoveryGuard(path: string): Promise<LockAttemptResult> {
    const guardPath = `${path}.recovery`
    let guard: Awaited<ReturnType<typeof open>> | undefined
    try {
      guard = await open(guardPath, 'wx', 0o600)
    } catch (error) {
      if (
        errorCode(error) === 'EEXIST' ||
        (process.platform === 'win32' && errorCode(error) === 'EPERM')
      ) {
        return { kind: 'contended' }
      }
      throw error
    }

    try {
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
        return { kind: 'acquired', nonce }
      } catch (error) {
        await handle?.close()
        if (
          errorCode(error) !== 'EEXIST' &&
          !(process.platform === 'win32' && errorCode(error) === 'EPERM')
        ) {
          throw error
        }
        return (await this.#recoverStaleLockExclusively(path))
          ? { kind: 'retry' }
          : { kind: 'contended' }
      }
    } finally {
      await guard?.close()
      try {
        await unlink(guardPath)
      } catch {
        // Leaving a recovery guard behind is safer than masking the lifecycle
        // operation that just completed. A later caller will fail closed until
        // an operator verifies no owner remains and removes the guard.
      }
    }
  }

  async #recoverStaleLockExclusively(path: string): Promise<boolean> {
    let metadata: LockMetadata | undefined
    let lockStat: Awaited<ReturnType<typeof stat>>
    try {
      lockStat = await stat(path)
      const candidate: unknown = JSON.parse(await readFile(path, 'utf8'))
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

    if (this.#now() - lockStat.mtimeMs < this.#staleLockMilliseconds) return false
    if (metadata !== undefined && this.#isProcessAlive(metadata.pid)) return false

    const stalePath = `${path}.stale.${this.#createNonce()}`
    try {
      await rename(path, stalePath)
      await rm(stalePath, { force: true })
      return true
    } catch (error) {
      return errorCode(error) === 'ENOENT'
    }
  }

  async #release(path: string, nonce: string): Promise<void> {
    try {
      const owner: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (
        owner !== null &&
        typeof owner === 'object' &&
        'nonce' in owner &&
        owner.nonce === nonce
      ) {
        await unlink(path)
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }
}

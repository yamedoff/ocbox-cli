import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectId, SessionId } from '../domain/ids.js'
import { findSensitiveMaterial } from '../security/redaction.js'
import { replaceFileAtomically } from '../state/exclusive-file-lock.js'
import {
  parsePendingSyncBaseline,
  parseSyncBaseline,
  type PendingSyncBaseline,
  type SyncBaselineEvidence,
  type VerifiedSyncBaseline,
} from './baseline.js'

export type SyncBaselineStoreErrorCode = 'CORRUPT_BASELINE' | 'UNSAFE_BASELINE'

/** Safe failure for persisted evidence that can never be loaded and trusted. */
export class SyncBaselineStoreError extends Error {
  constructor(readonly code: SyncBaselineStoreErrorCode) {
    super(`Sync baseline failed: ${code}`)
    this.name = 'SyncBaselineStoreError'
  }
}

/**
 * Persists the last verified three-way baseline per Session, plus the durable
 * intent written before a target commit and promoted afterward. The documents
 * contain only relative POSIX paths, hashes, modes, and timestamps: never
 * source content, absolute host paths, or excluded secret names. Writes are
 * atomic and the verified baseline is only promoted after a complete apply.
 */
export class SyncBaselineStore {
  readonly #directory: string
  readonly #path: string
  readonly #pendingPath: string

  constructor(stateDirectory: string, projectId: ProjectId, sessionId: SessionId) {
    this.#directory = join(stateDirectory, 'sync', projectId, sessionId)
    this.#path = join(this.#directory, 'baseline.json')
    this.#pendingPath = join(this.#directory, 'pending-baseline.json')
  }

  async load(): Promise<SyncBaselineEvidence | null> {
    const source = await this.#read(this.#path)
    if (source === null) return null
    try {
      const parsed = parseSyncBaseline(JSON.parse(source))
      if (findSensitiveMaterial(parsed).length > 0)
        throw new SyncBaselineStoreError('UNSAFE_BASELINE')
      return parsed
    } catch (error) {
      if (error instanceof SyncBaselineStoreError) throw error
      throw new SyncBaselineStoreError('CORRUPT_BASELINE')
    }
  }

  /** Reads the pre-commit intent, if a previous apply left one behind. */
  async loadPending(): Promise<PendingSyncBaseline | null> {
    const source = await this.#read(this.#pendingPath)
    if (source === null) return null
    try {
      const parsed = parsePendingSyncBaseline(JSON.parse(source))
      if (findSensitiveMaterial(parsed).length > 0)
        throw new SyncBaselineStoreError('UNSAFE_BASELINE')
      return parsed
    } catch (error) {
      if (error instanceof SyncBaselineStoreError) throw error
      throw new SyncBaselineStoreError('CORRUPT_BASELINE')
    }
  }

  async save(baseline: VerifiedSyncBaseline): Promise<void> {
    if (findSensitiveMaterial(baseline).length > 0) {
      throw new SyncBaselineStoreError('UNSAFE_BASELINE')
    }
    await this.#writeAtomic(this.#path, baseline)
  }

  /**
   * Writes the durable intent before the target is mutated. The verified
   * baseline stays untouched until `promotePending` proves the apply succeeded.
   */
  async savePending(pending: PendingSyncBaseline): Promise<void> {
    if (findSensitiveMaterial(pending).length > 0) {
      throw new SyncBaselineStoreError('UNSAFE_BASELINE')
    }
    try {
      parsePendingSyncBaseline(pending)
    } catch {
      throw new SyncBaselineStoreError('UNSAFE_BASELINE')
    }
    await this.#writeAtomic(this.#pendingPath, pending)
  }

  /** Atomically installs the pending intent's verified baseline, then clears it. */
  async promotePending(): Promise<void> {
    const source = await this.#read(this.#pendingPath)
    if (source === null) throw new SyncBaselineStoreError('CORRUPT_BASELINE')
    let pending: PendingSyncBaseline
    try {
      pending = parsePendingSyncBaseline(JSON.parse(source))
    } catch {
      throw new SyncBaselineStoreError('CORRUPT_BASELINE')
    }
    await this.save(pending.baseline)
    await this.clearPending()
  }

  /** Discards a pending intent whose target never reached the desired state. */
  async clearPending(): Promise<void> {
    await rm(this.#pendingPath, { force: true })
  }

  async #read(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async #writeAtomic(path: string, value: unknown): Promise<void> {
    await mkdir(this.#directory, { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await replaceFileAtomically(temporary, path)
    } catch (error) {
      await handle?.close()
      await rm(temporary, { force: true })
      throw error
    }
  }
}

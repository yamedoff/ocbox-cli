import type { SyncSnapshotEntry } from './baseline.js'

/**
 * Provider-neutral transaction boundary for a complete, authenticated source
 * snapshot. Implementations stage every entry, verify its checksum, and only
 * replace a target after the caller has explicitly approved that replacement.
 * A failed commit must leave a recoverable journal; callers must not retry a
 * transaction blindly when `recoveryRequired` is true.
 */
export interface TransferAdapter {
  readonly name: string
  beginApply(intent: TransferApplyIntent): Promise<TransferTransaction>
  recoveryStatus(): Promise<TransferRecoveryStatus>
  recover(): Promise<void>
}

export interface TransferApplyIntent {
  /** The planner has verified the target snapshot and approved replacement. */
  readonly allowReplace: boolean
}

export interface TransferTransaction {
  stage(entries: readonly SyncSnapshotEntry[], archive: AsyncIterable<Uint8Array>): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
}

export interface TransferRecoveryStatus {
  readonly recoveryRequired: boolean
  readonly operationId: string | null
}

/**
 * `INTEGRITY` means staged/archive content failed verification.
 * `RECOVERY_REQUIRED` means an incomplete transaction must be resolved first.
 * `REPLACE_NOT_APPROVED` means the caller did not authorize replacing a
 * non-empty target. `UNSAFE_TARGET` means the target root itself is a link and
 * must not be dereferenced.
 */
export class TransferError extends Error {
  constructor(
    readonly code: 'INTEGRITY' | 'RECOVERY_REQUIRED' | 'REPLACE_NOT_APPROVED' | 'UNSAFE_TARGET',
  ) {
    super(`Sync transfer failed: ${code}`)
    this.name = 'TransferError'
  }
}

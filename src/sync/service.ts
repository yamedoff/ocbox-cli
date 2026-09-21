import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ProjectId, SessionId } from '../domain/ids.js'
import { OperationIdSchema, RequestIdSchema } from '../domain/ids.js'
import { UtcTimestampSchema } from '../domain/timestamps.js'
import {
  OcboxError,
  type OcboxErrorCode,
  type RedactedDetails,
  RedactedDetailsSchema,
} from '../errors/index.js'
import { findSensitiveMaterial } from '../security/redaction.js'
import { ExclusiveFileLock } from '../state/exclusive-file-lock.js'
import { encodeSyncArchive, SyncArchiveError } from './archive.js'
import {
  createVerifiedBaseline,
  snapshotEntries,
  snapshotSha256,
  type SyncBaselineEvidence,
  type SyncSnapshotEntry,
} from './baseline.js'
import { SyncBaselineStore, SyncBaselineStoreError } from './baseline-store.js'
import type { IgnoreRule } from './exclusions.js'
import { loadIgnoreRuleGroups } from './ignore-rules.js'
import { type BlockedSourceEntry, scanSourceManifest, type SourceManifest } from './manifest.js'
import type { ManifestPath, PathCollision } from './path-policy.js'
import {
  planSync,
  type SyncConflict,
  type SyncMode,
  type SyncOperation,
  type SyncPlan,
  type SyncRename,
  type SyncChange,
} from './planner.js'
import { createTransferAdapter } from './provider-adapter.js'
import { TransferError } from './transfer.js'

/** Everything the sync command needs, already resolved through T4/T5 services. */
export interface SyncContext {
  readonly providerName: string
  readonly projectId: ProjectId
  readonly sessionId: SessionId
  readonly stateDirectory: string
  readonly localRoot: string
  readonly remoteRoot: string
}

export interface SyncChangeView {
  readonly side: string
  readonly kind: string
  readonly path: string
}

export interface SyncRenameView {
  readonly side: string
  readonly fromPath: string
  readonly toPath: string
  readonly sha256: string
}

export interface SyncConflictView {
  readonly kind: string
  readonly path: string | null
  readonly relatedPaths: readonly string[]
}

export interface SyncOperationView {
  readonly kind: string
  readonly source: string
  readonly path: string
  readonly fromPath: string | null
}

export interface SyncBlockedView {
  readonly path: string
  readonly reason: string
}

/** Excluded secret/cache material is reported by name but never transferred. */
export interface SyncExcludedView {
  readonly side: string
  readonly path: string
  readonly reason: string
}

export interface SyncCollisionView {
  readonly canonicalPath: string
  readonly kind: string
  readonly sourcePaths: readonly string[]
}

export interface SyncPlanView {
  readonly schemaVersion: 1
  readonly mode: SyncMode
  readonly sessionId: string
  readonly firstSync: boolean
  readonly additions: readonly SyncChangeView[]
  readonly modifications: readonly SyncChangeView[]
  readonly deletions: readonly SyncChangeView[]
  readonly renames: readonly SyncRenameView[]
  readonly conflicts: readonly SyncConflictView[]
  readonly operations: readonly SyncOperationView[]
  readonly requiresDeletionApproval: boolean
  readonly blocked: readonly SyncBlockedView[]
  readonly collisions: readonly SyncCollisionView[]
  readonly excluded: readonly SyncExcludedView[]
}

export interface SyncApplyView extends SyncPlanView {
  readonly applied: boolean
  readonly baselineUpdated: boolean
  /** Identity of the applied operation, or null when the plan was a no-op. */
  readonly operationId: string | null
}

export interface SyncRecoverView {
  readonly schemaVersion: 1
  readonly sessionId: string
  readonly recovered: boolean
  readonly operationId: string | null
}

/** Test/embedding seam for the per-Session serialization lock wait. */
export interface SyncLockOptions {
  readonly lockTimeoutMilliseconds?: number
}

export interface SyncApplyOptions extends SyncLockOptions {
  readonly cliRules: readonly IgnoreRule[]
  readonly delete: boolean
  readonly yes: boolean
  readonly interactive: boolean
  readonly confirm: () => Promise<boolean>
  readonly now?: () => Date
}

export interface SyncDiffOptions {
  readonly cliRules: readonly IgnoreRule[]
}

export interface SyncRecoverOptions extends SyncLockOptions {}

function requestId(): ReturnType<typeof RequestIdSchema.parse> {
  return RequestIdSchema.parse(randomUUID())
}

function syncError(code: OcboxErrorCode, message: string, details?: RedactedDetails): OcboxError {
  // Details are re-validated so an unexpectedly sensitive report path can never
  // turn a typed sync failure into an unhandled schema error.
  const safe = details === undefined ? undefined : RedactedDetailsSchema.safeParse(details)
  const resolved = safe?.success === true ? safe.data : undefined
  return new OcboxError({
    code,
    message,
    requestId: requestId(),
    ...(resolved === undefined ? {} : { details: resolved }),
  })
}

function emptySourceManifest(): SourceManifest {
  return {
    schemaVersion: 1,
    entries: [],
    canonicalJsonl: new Uint8Array(),
    manifestSha256: createHash('sha256').update(new Uint8Array()).digest('hex'),
    totalBytes: 0,
    transferableFiles: 0,
    blocked: [],
    blockedOverflow: false,
    collisions: [],
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path)
    return metadata.isDirectory() && !metadata.isSymbolicLink()
  } catch {
    return false
  }
}

async function scanSide(root: string, cliRuleList: readonly IgnoreRule[]): Promise<SourceManifest> {
  if (!(await isDirectory(root))) return emptySourceManifest()
  const groups = await loadIgnoreRuleGroups(root, cliRuleList)
  return scanSourceManifest(root, { ignoreRuleGroups: groups })
}

interface PlanInputs {
  readonly plan: SyncPlan
  readonly localManifest: SourceManifest
  readonly remoteManifest: SourceManifest
}

function baselineStore(context: SyncContext): SyncBaselineStore {
  return new SyncBaselineStore(context.stateDirectory, context.projectId, context.sessionId)
}

function baselineFailure(error: unknown): OcboxError {
  if (error instanceof SyncBaselineStoreError && error.code === 'UNSAFE_BASELINE') {
    return baselineUnsafeError()
  }
  if (error instanceof OcboxError) return error
  return syncError(
    'SYNC_INTEGRITY',
    'The stored sync baseline is unreadable; resolve it before syncing again',
  )
}

async function loadBaseline(context: SyncContext): Promise<SyncBaselineEvidence | null> {
  try {
    return await baselineStore(context).load()
  } catch (error) {
    throw baselineFailure(error)
  }
}

async function buildPlan(
  context: SyncContext,
  mode: SyncMode,
  cliRuleList: readonly IgnoreRule[],
): Promise<PlanInputs> {
  const localManifest = await scanSide(context.localRoot, cliRuleList)
  const remoteManifest = await scanSide(context.remoteRoot, cliRuleList)
  const baseline = await loadBaseline(context)
  const plan = planSync({
    mode,
    local: snapshotEntries(localManifest),
    remote: snapshotEntries(remoteManifest),
    baseline,
  })
  return { plan, localManifest, remoteManifest }
}

interface PendingReconcileResult {
  readonly hadPending: boolean
  readonly operationId: string | null
}

function targetRootForSide(context: SyncContext, side: 'local' | 'remote'): string {
  return side === 'remote' ? context.remoteRoot : context.localRoot
}

/**
 * A completed transfer installs exactly the desired snapshot, so comparing the
 * on-disk target against it is rule-independent: built-in exclusions already
 * removed any non-transferable content before the transfer began.
 */
async function targetMatchesSnapshot(
  targetRoot: string,
  desired: readonly SyncSnapshotEntry[],
): Promise<boolean> {
  if (!(await isDirectory(targetRoot))) return desired.length === 0
  let manifest: SourceManifest
  try {
    manifest = await scanSourceManifest(targetRoot, { ignoreRuleGroups: [] })
  } catch {
    return false
  }
  return snapshotSha256(snapshotEntries(manifest)) === snapshotSha256(desired)
}

/**
 * Resolves a pending-baseline intent left by a crash between target commit and
 * baseline persistence. The target is inspected without promoting staged data:
 * an exact match proves the commit completed, so the intent is promoted;
 * otherwise the commit never landed, so the intent is discarded and the prior
 * verified baseline is kept.
 */
async function reconcilePendingBaseline(context: SyncContext): Promise<PendingReconcileResult> {
  const store = baselineStore(context)
  let pending: Awaited<ReturnType<SyncBaselineStore['loadPending']>>
  try {
    pending = await store.loadPending()
  } catch (error) {
    throw baselineFailure(error)
  }
  if (pending === null) return { hadPending: false, operationId: null }
  const matches = await targetMatchesSnapshot(
    targetRootForSide(context, pending.targetSide),
    pending.baseline.entries,
  )
  try {
    if (matches) await store.promotePending()
    else await store.clearPending()
  } catch (error) {
    throw baselineFailure(error)
  }
  return { hadPending: true, operationId: pending.operationId }
}

/** Fails closed while a pre-commit intent is unpersisted and unreconciled. */
async function assertNoPendingBaseline(context: SyncContext): Promise<void> {
  let pending: Awaited<ReturnType<SyncBaselineStore['loadPending']>>
  try {
    pending = await baselineStore(context).loadPending()
  } catch (error) {
    throw baselineFailure(error)
  }
  if (pending !== null) throw recoveryRequiredError(pending.operationId)
}

/** A provider without a transfer adapter has no journal, so it cannot recover. */
async function recoveryStatusFor(
  context: SyncContext,
  targetRoot: string,
): Promise<{ recoveryRequired: boolean; operationId: string | null } | null> {
  try {
    return await createTransferAdapter(context.providerName, targetRoot).recoveryStatus()
  } catch (error) {
    if (error instanceof OcboxError && error.code === 'CAPABILITY_UNSUPPORTED') return null
    throw error
  }
}

/** An unresolved journal on either target leaves state unknown; fail closed. */
async function assertNoRecovery(context: SyncContext): Promise<void> {
  for (const targetRoot of [context.remoteRoot, context.localRoot]) {
    const status = await recoveryStatusFor(context, targetRoot)
    if (status?.recoveryRequired === true) throw recoveryRequiredError(status.operationId)
  }
}

const SYNC_LOCK_TIMEOUT_MILLISECONDS = 5_000

/** Internal sentinel so a lock wait failure is never confused with sync work. */
class SyncLockWaitError extends Error {}

/**
 * Serializes sync mutations for a Session so concurrent writers cannot race the
 * transfer journal or the verified baseline. Contention fails closed rather
 * than waiting forever.
 */
async function withSyncLock<Result>(
  context: SyncContext,
  options: SyncLockOptions,
  action: () => Promise<Result>,
): Promise<Result> {
  const lock = new ExclusiveFileLock({
    timeoutMilliseconds: options.lockTimeoutMilliseconds ?? SYNC_LOCK_TIMEOUT_MILLISECONDS,
    createTimeoutError: () => new SyncLockWaitError(),
    createCancelledError: () => new SyncLockWaitError(),
  })
  const path = join(
    context.stateDirectory,
    'sync',
    context.projectId,
    context.sessionId,
    'sync.lock',
  )
  try {
    return await lock.withLock(path, undefined, action)
  } catch (error) {
    if (error instanceof SyncLockWaitError) {
      throw syncError(
        'OPERATION_CONFLICT',
        'Another sync operation is already running for this Session; retry after it finishes',
      )
    }
    throw error
  }
}

function blockedView(entry: BlockedSourceEntry): SyncBlockedView {
  return { path: entry.path, reason: entry.reason }
}

function collisionView(collision: PathCollision): SyncCollisionView {
  return {
    canonicalPath: collision.canonicalPath,
    kind: collision.kind,
    sourcePaths: [...collision.sourcePaths],
  }
}

function changeView(change: SyncChange): SyncChangeView {
  return { side: change.side, kind: change.kind, path: change.path }
}

function renameView(rename: SyncRename): SyncRenameView {
  return {
    side: rename.side,
    fromPath: rename.fromPath,
    toPath: rename.toPath,
    sha256: rename.sha256,
  }
}

function conflictView(conflict: SyncConflict): SyncConflictView {
  return {
    kind: conflict.kind,
    path: conflict.path,
    relatedPaths: [...conflict.relatedPaths],
  }
}

function operationView(operation: SyncOperation): SyncOperationView {
  return {
    kind: operation.kind,
    source: operation.source,
    path: operation.path,
    fromPath: operation.fromPath,
  }
}

function excludedView(side: string, manifest: SourceManifest): readonly SyncExcludedView[] {
  return manifest.entries
    .filter((entry) => entry.exclusionReason !== null)
    .slice(0, 200)
    .map((entry) => ({
      side,
      path: entry.path,
      reason: entry.exclusionReason ?? 'user-rule',
    }))
}

function toPlanView(plan: SyncPlan, context: SyncContext, inputs: PlanInputs): SyncPlanView {
  return {
    schemaVersion: 1,
    mode: plan.mode,
    sessionId: context.sessionId,
    firstSync: plan.firstSync,
    additions: plan.additions.map(changeView),
    modifications: plan.modifications.map(changeView),
    deletions: plan.deletions.map(changeView),
    renames: plan.renames.map(renameView),
    conflicts: plan.conflicts.map(conflictView),
    operations: plan.operations.map(operationView),
    requiresDeletionApproval: plan.requiresDeletionApproval,
    blocked: [
      ...inputs.localManifest.blocked.map(blockedView),
      ...inputs.remoteManifest.blocked.map(blockedView),
    ],
    collisions: [
      ...inputs.localManifest.collisions.map(collisionView),
      ...inputs.remoteManifest.collisions.map(collisionView),
    ],
    excluded: [
      ...excludedView('local', inputs.localManifest),
      ...excludedView('remote', inputs.remoteManifest),
    ],
  }
}

const SIZE_LIMIT_REASONS = new Set<BlockedSourceEntry['reason']>([
  'entry-limit',
  'file-limit',
  'size-limit',
])

/** Reports blocked/colliding source material without ever transferring it. */
function assertionDetails(manifests: readonly SourceManifest[]): RedactedDetails {
  const blocked = manifests
    .flatMap((manifest) => manifest.blocked)
    .slice(0, 50)
    .map((entry) => ({ path: entry.path, reason: entry.reason }))
  const collisions = manifests
    .flatMap((manifest) => manifest.collisions)
    .slice(0, 50)
    .map((collision) => ({ path: collision.canonicalPath, kind: collision.kind }))
  return {
    blockedCount: manifests.reduce((total, manifest) => total + manifest.blocked.length, 0),
    collisionCount: manifests.reduce((total, manifest) => total + manifest.collisions.length, 0),
    blocked,
    collisions,
  }
}

function assertManifestsTransferable(manifests: readonly SourceManifest[]): void {
  const allBlocked = manifests.flatMap((manifest) => manifest.blocked)
  const collisionCount = manifests.reduce(
    (total, manifest) => total + manifest.collisions.length,
    0,
  )
  if (allBlocked.length === 0 && collisionCount === 0) return
  const onlySizeLimits =
    collisionCount === 0 && allBlocked.every((entry) => SIZE_LIMIT_REASONS.has(entry.reason))
  if (onlySizeLimits) {
    throw syncError(
      'SYNC_TOO_LARGE',
      'The source exceeds the provisional size, file, or entry limits; nothing was transferred',
      assertionDetails(manifests),
    )
  }
  throw syncError(
    'SYNC_CONFLICT',
    'The source contains blocked or colliding paths; nothing was transferred',
    assertionDetails(manifests),
  )
}

function conflictError(conflicts: readonly SyncConflict[]): OcboxError {
  return syncError(
    'SYNC_CONFLICT',
    'Sync refused because the local and remote trees diverged; resolve the conflicts and retry',
    {
      conflictCount: conflicts.length,
      conflicts: conflicts.slice(0, 50).map((conflict) => ({
        kind: conflict.kind,
        path: conflict.path,
        relatedPaths: [...conflict.relatedPaths],
      })),
    },
  )
}

function deletionRequiredError(): OcboxError {
  return syncError(
    'SYNC_CONFLICT',
    'This sync deletes target entries; rerun with --delete to acknowledge each deletion',
  )
}

function deletionConfirmationError(): OcboxError {
  return syncError(
    'SYNC_CONFLICT',
    'Destructive sync requires interactive confirmation or an explicit --yes acknowledgement',
  )
}

function recoveryRequiredError(operationId: string | null): OcboxError {
  return syncError(
    'SYNC_FAILED',
    'A previous sync was interrupted and requires recovery; run ocbox sync recover before retrying',
    operationId === null ? undefined : { operationId },
  )
}

function baselineUnsafeError(): OcboxError {
  return syncError(
    'SYNC_CONFLICT',
    'The verified baseline would persist secret-like material; refusing to commit',
  )
}

function transferFailure(error: unknown): OcboxError {
  if (error instanceof OcboxError) return error
  if (error instanceof SyncArchiveError) {
    if (error.code === 'ARCHIVE_LIMIT') {
      return syncError('SYNC_TOO_LARGE', 'The sync archive exceeds the provisional limits')
    }
    return syncError('SYNC_INTEGRITY', 'The sync archive failed integrity verification')
  }
  if (error instanceof TransferError) {
    switch (error.code) {
      case 'RECOVERY_REQUIRED':
        return syncError(
          'SYNC_FAILED',
          'The transfer was interrupted and requires recovery; run ocbox sync recover',
        )
      case 'REPLACE_NOT_APPROVED':
        return syncError('SYNC_CONFLICT', 'The sync target replacement was not approved')
      case 'UNSAFE_PATH':
        return syncError(
          'SYNC_CONFLICT',
          'Excluded target material could not be preserved during the sync; nothing was replaced',
        )
      case 'UNSAFE_TARGET':
        return syncError('SYNC_CONFLICT', 'The sync target root is a link and was not dereferenced')
      case 'INTEGRITY':
        return syncError('SYNC_INTEGRITY', 'Staged content failed checksum verification')
    }
  }
  if (error instanceof SyncBaselineStoreError) {
    return syncError('SYNC_INTEGRITY', 'The verified baseline could not be persisted safely')
  }
  return syncError('SYNC_INTEGRITY', 'The sync transfer failed integrity verification')
}

/**
 * `diff` is always non-mutating and never rejects on conflicts or blocked
 * paths, but it still fails closed when an unresolved recovery or a pending
 * baseline leaves the comparison ambiguous.
 */
export async function runSyncDiff(
  context: SyncContext,
  options: SyncDiffOptions,
): Promise<SyncPlanView> {
  await assertNoRecovery(context)
  await assertNoPendingBaseline(context)
  const inputs = await buildPlan(context, 'diff', options.cliRules)
  return toPlanView(inputs.plan, context, inputs)
}

function rootsFor(mode: Exclude<SyncMode, 'diff'>, context: SyncContext) {
  return mode === 'push'
    ? { sourceRoot: context.localRoot, targetRoot: context.remoteRoot }
    : { sourceRoot: context.remoteRoot, targetRoot: context.localRoot }
}

function manifestsFor(
  mode: Exclude<SyncMode, 'diff'>,
  inputs: PlanInputs,
): { sourceManifest: SourceManifest; targetManifest: SourceManifest } {
  return mode === 'push'
    ? { sourceManifest: inputs.localManifest, targetManifest: inputs.remoteManifest }
    : { sourceManifest: inputs.remoteManifest, targetManifest: inputs.localManifest }
}

async function assertSafeTarget(root: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>
  try {
    metadata = await lstat(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (metadata.isSymbolicLink()) {
    throw syncError('SYNC_CONFLICT', 'The sync target root is a link and was not dereferenced')
  }
  if (!metadata.isDirectory()) {
    throw syncError('SYNC_CONFLICT', 'The sync target exists and is not a directory')
  }
}

async function* openSourceFile(root: string, path: ManifestPath): AsyncIterable<Uint8Array> {
  const candidate = resolve(root, ...path.split('/'))
  const rel = relative(root, candidate)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SyncArchiveError('SOURCE_READ')
  }
  const metadata = await lstat(candidate)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new SyncArchiveError('SOURCE_READ')
  const canonical = await realpath(candidate)
  const canonicalRel = relative(root, canonical)
  if (canonicalRel === '..' || canonicalRel.startsWith(`..${sep}`) || isAbsolute(canonicalRel)) {
    throw new SyncArchiveError('SOURCE_READ')
  }
  const handle = await open(candidate, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new SyncArchiveError('SOURCE_READ')
    }
    const chunks = handle.createReadStream({ autoClose: false })
    for await (const chunk of chunks) yield new Uint8Array(chunk as Uint8Array)
  } finally {
    await handle.close()
  }
}

/**
 * Applies a one-way push or pull. Conflicts, blocked paths, unresolved recovery,
 * and unapproved deletions all fail closed before any target mutation.
 */
export async function runSyncApply(
  context: SyncContext,
  mode: Exclude<SyncMode, 'diff'>,
  options: SyncApplyOptions,
): Promise<SyncApplyView> {
  const now = options.now ?? (() => new Date())
  const roots = rootsFor(mode, context)
  const adapter = createTransferAdapter(context.providerName, roots.targetRoot)

  return withSyncLock(context, options, async () => {
    await assertSafeTarget(roots.targetRoot)
    // An unresolved journal on either target makes state unknown, so recovery
    // always gates planning and mutation. Staged content is never promoted.
    await assertNoRecovery(context)
    // A pre-commit intent from an earlier crash is reconciled against the
    // on-disk target before any new plan is trusted.
    await reconcilePendingBaseline(context)

    const inputs = await buildPlan(context, mode, options.cliRules)
    const { sourceManifest, targetManifest } = manifestsFor(mode, inputs)
    assertManifestsTransferable([sourceManifest, targetManifest])
    if (inputs.plan.conflicts.length > 0) throw conflictError(inputs.plan.conflicts)
    const view = toPlanView(inputs.plan, context, inputs)
    if (inputs.plan.operations.length === 0) {
      return { ...view, applied: false, baselineUpdated: false, operationId: null }
    }

    if (inputs.plan.requiresDeletionApproval) {
      if (!options.delete) throw deletionRequiredError()
      if (!options.yes) {
        if (!options.interactive) throw deletionConfirmationError()
        if (!(await options.confirm())) throw deletionConfirmationError()
      }
    }

    const desired: readonly SyncSnapshotEntry[] = snapshotEntries(sourceManifest)
    const baseline = createVerifiedBaseline(
      sourceManifest,
      UtcTimestampSchema.parse(now().toISOString()),
    )
    if (findSensitiveMaterial(baseline).length > 0) throw baselineUnsafeError()

    const operationId = OperationIdSchema.parse(randomUUID())
    const store = baselineStore(context)
    // Persist the intent before mutating the target so a crash after commit is
    // reconcilable instead of an ambiguous divergence.
    try {
      await store.savePending({
        schemaVersion: 1,
        operationId,
        mode,
        targetSide: mode === 'push' ? 'remote' : 'local',
        baseline,
      })
    } catch (error) {
      throw transferFailure(error)
    }

    const canonicalRoot = await realpath(roots.sourceRoot)
    // Excluded target-side material (secrets, caches, VCS metadata, user rules)
    // is invisible to the planner, so a whole-root swap would delete it without
    // the `--delete` gate ever seeing it. The adapter carries these paths into
    // the staged root before replacing the target, and any carry-over race
    // fails closed before the destructive move instead of deleting silently.
    const carryOverPaths = targetManifest.entries
      .filter((entry) => entry.exclusionReason !== null)
      .map((entry) => entry.path)
    let transaction: Awaited<ReturnType<typeof adapter.beginApply>> | undefined
    try {
      transaction = await adapter.beginApply({ allowReplace: true, carryOverPaths })
      await transaction.stage(
        desired,
        encodeSyncArchive(desired, (path) => openSourceFile(canonicalRoot, path)),
      )
      await transaction.commit()
    } catch (error) {
      await transaction?.rollback().catch(() => undefined)
      // Only discard the intent once recovery confirms the target is stable
      // again; otherwise keep it so `sync recover` can reconcile it.
      const settled = await adapter.recoveryStatus().catch(() => null)
      if (settled === null || !settled.recoveryRequired) {
        await store.clearPending().catch(() => undefined)
      }
      throw transferFailure(error)
    }

    try {
      await store.promotePending()
    } catch {
      // The target is already committed; the pending intent lets the next run
      // promote the baseline rather than reporting a false conflict.
      throw syncError(
        'SYNC_INTEGRITY',
        'The sync applied but its baseline could not be persisted; retry or run ocbox sync recover',
      )
    }
    return { ...view, applied: true, baselineUpdated: true, operationId }
  })
}

/**
 * Explicitly resolves recovery-required state on both possible targets and
 * reconciles a pending baseline. Staged content is never promoted implicitly.
 */
export async function runSyncRecover(
  context: SyncContext,
  options: SyncRecoverOptions = {},
): Promise<SyncRecoverView> {
  return withSyncLock(context, options, async () => {
    let recovered = false
    let operationId: string | null = null
    // A push journals against the remote target; a pull journals against local.
    for (const targetRoot of [context.remoteRoot, context.localRoot]) {
      const adapter = createTransferAdapter(context.providerName, targetRoot)
      const status = await adapter.recoveryStatus()
      if (!status.recoveryRequired) continue
      try {
        await adapter.recover()
      } catch (error) {
        throw transferFailure(error)
      }
      recovered = true
      operationId ??= status.operationId
    }
    const pending = await reconcilePendingBaseline(context)
    if (pending.hadPending) {
      recovered = true
      operationId ??= pending.operationId
    }
    return { schemaVersion: 1, sessionId: context.sessionId, recovered, operationId }
  })
}

export function renderSyncPlan(view: SyncPlanView): string {
  const lines: string[] = []
  const header = view.firstSync
    ? `First sync plan (${view.mode}) for session ${view.sessionId}`
    : `Sync plan (${view.mode}) for session ${view.sessionId}`
  lines.push(header)
  for (const change of view.additions) lines.push(`+ ${change.kind} ${change.side}:${change.path}`)
  for (const change of view.modifications) {
    lines.push(`~ ${change.kind} ${change.side}:${change.path}`)
  }
  for (const change of view.deletions) lines.push(`- ${change.kind} ${change.side}:${change.path}`)
  for (const rename of view.renames) {
    lines.push(`> rename ${rename.side}:${rename.fromPath} -> ${rename.toPath}`)
  }
  for (const conflict of view.conflicts) {
    lines.push(`! conflict ${conflict.kind} ${conflict.path ?? '(tree)'}`)
  }
  for (const blocked of view.blocked) lines.push(`! blocked ${blocked.reason} ${blocked.path}`)
  for (const collision of view.collisions) {
    lines.push(`! collision ${collision.kind} ${collision.canonicalPath}`)
  }
  for (const excluded of view.excluded) {
    lines.push(`= excluded ${excluded.reason} ${excluded.side}:${excluded.path}`)
  }
  if (
    view.additions.length === 0 &&
    view.modifications.length === 0 &&
    view.deletions.length === 0 &&
    view.renames.length === 0 &&
    view.conflicts.length === 0 &&
    view.blocked.length === 0 &&
    view.collisions.length === 0
  ) {
    lines.push('No changes.')
  }
  return lines.join('\n')
}

export function renderSyncApplied(view: SyncApplyView): string {
  if (!view.applied) {
    return `${view.mode === 'push' ? 'Push' : 'Pull'} skipped: no changes to apply.`
  }
  const deletions = view.operations.filter((operation) => operation.kind === 'delete').length
  const files = view.operations.filter((operation) => operation.kind === 'put-file').length
  const directories = view.operations.filter(
    (operation) => operation.kind === 'ensure-directory',
  ).length
  const renames = view.operations.filter((operation) => operation.kind === 'rename').length
  const verb = view.mode === 'push' ? 'Pushed' : 'Pulled'
  return `${verb} ${String(files)} file(s), ${String(directories)} directory(ies), ${String(renames)} rename(s), ${String(deletions)} deletion(s); baseline updated.`
}

export function renderSyncRecover(view: SyncRecoverView): string {
  return view.recovered
    ? `Recovered interrupted sync${view.operationId === null ? '' : ` ${view.operationId}`}.`
    : 'No recovery was required.'
}

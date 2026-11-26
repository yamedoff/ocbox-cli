import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { newRequestId } from '../auth/errors.js'
import { UtcTimestampSchema } from '../domain/timestamps.js'
import { OcboxError, type RedactedDetails, RedactedDetailsSchema } from '../errors/index.js'
import { CasPlanRefused } from '../providers/ocbox/cas.js'
import { isCliOutdatedError } from '../version/gate.js'
import {
  type SyncSnapshotEntry,
  snapshotEntries,
  snapshotSha256,
  VerifiedSyncBaselineSchema,
} from './baseline.js'
import { SyncBaselineStore, SyncBaselineStoreError } from './baseline-store.js'
import {
  CAS_LIMITS,
  type CasBlob,
  type CasFastTransport,
  type CasFile,
  casTreeFingerprint,
} from './cas-contract.js'
import {
  buildCasSnapshot,
  casError,
  prepareCasDirectory,
  readCasState,
  writeCasState,
} from './cas-snapshot.js'
import { fastApplyCasSnapshot, syncCasSnapshot } from './cas-transfer.js'
import { InvalidIgnoreRuleError } from './exclusions.js'
import { loadIgnoreRuleGroups, sourceExclusionForPath } from './ignore-rules.js'
import { type SourceManifest, scanSourceManifest } from './manifest.js'
import type { ManifestPath } from './path-policy.js'
import type { SyncApplyOptions, SyncApplyView, SyncContext } from './service.js'

function comparePath(left: { path: string }, right: { path: string }): number {
  return Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'))
}

function comparePathString(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/**
 * The CAS protocol records only the execute bit on files and a fixed directory
 * mode. Normalizing before planning keeps a Windows scan (which reports other
 * modes) from looking like a content change.
 */
export function casComparableEntry(entry: SyncSnapshotEntry): SyncSnapshotEntry {
  if (entry.type === 'directory') {
    return entry.mode === 0o755 ? entry : { ...entry, mode: 0o755 }
  }
  const mode = entry.mode & 0o111 ? 493 : 420
  return entry.mode === mode ? entry : { ...entry, mode }
}

export interface CasStatePaths {
  readonly directory: string
  readonly statePath: string
  readonly pendingPath: string
  readonly cache: string
}

/** The per-Session, per-root CAS state that caches blobs and the last pushed tree. */
export function casStatePaths(context: SyncContext, scope: string): CasStatePaths {
  const key = createHash('sha256')
    .update(JSON.stringify([scope, context.localRoot]))
    .digest('hex')
  const directory = join(
    context.stateDirectory,
    'sync',
    context.projectId,
    context.sessionId,
    'cas',
    key,
  )
  return {
    directory,
    statePath: join(directory, 'state.json'),
    pendingPath: join(directory, 'pending.json'),
    cache: join(directory, 'blobs'),
  }
}

/**
 * Persists the verified three-way baseline for hosted sync. The baseline is the
 * last tree both sides agreed on, so a later pull can prove a local edit is
 * newer than the box copy instead of overwriting it.
 */
export async function saveHostedBaseline(
  context: SyncContext,
  entries: readonly SyncSnapshotEntry[],
  now: () => Date = () => new Date(),
): Promise<void> {
  const sorted = entries.map(casComparableEntry).sort(comparePath)
  const baseline = VerifiedSyncBaselineSchema.parse({
    schemaVersion: 1,
    verified: true,
    verifiedAt: UtcTimestampSchema.parse(now().toISOString()),
    snapshotSha256: snapshotSha256(sorted),
    entries: sorted,
  })
  try {
    await new SyncBaselineStore(context.stateDirectory, context.projectId, context.sessionId).save(
      baseline,
    )
  } catch (error) {
    if (error instanceof SyncBaselineStoreError && error.code === 'UNSAFE_BASELINE')
      throw casError(
        'SYNC_CONFLICT',
        'The sync applied, but its verified baseline contains secret-like material and was not saved; resolve the path and retry',
      )
    throw casError(
      'SYNC_INTEGRITY',
      'The sync baseline could not be persisted safely; retry the command',
    )
  }
}

export interface SyncConflictReport {
  readonly path: string | null
  readonly kind: string
  readonly sides: readonly string[]
}

/** Quotes one manifest path for a copy-pasteable `ocbox sync ...` next step. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function listConflictPaths(paths: readonly string[], limit = 10): string {
  const shown = paths.slice(0, limit).join(', ')
  const remaining = paths.length - Math.min(paths.length, limit)
  return remaining > 0 ? `${shown}, and ${String(remaining)} more` : shown
}

export function pushExcludeNextStep(paths: readonly string[]): string {
  if (paths.length === 0) return 'ocbox sync diff'
  const shown = paths.slice(0, 5)
  const remaining = paths.length - shown.length
  const command = `ocbox sync push ${shown.map((path) => `--exclude ${shellQuote(path)}`).join(' ')}`
  return remaining === 0
    ? command
    : `${command} # and ${String(remaining)} more: repeat --exclude for each path in details.paths`
}

function safeDetails(details: RedactedDetails): RedactedDetails | undefined {
  const parsed = RedactedDetailsSchema.safeParse(details)
  return parsed.success ? parsed.data : undefined
}

/**
 * A conflict that names every path, the changed sides and the exact next
 * command. `details.paths` and `details.nextStep` are the stable JSON surface.
 */
export function syncConflictError(input: {
  readonly message: string
  readonly paths: readonly string[]
  readonly conflicts: readonly SyncConflictReport[]
  readonly nextStep: string
  readonly reasonCode?: string
  readonly requestId?: OcboxError['requestId']
}): OcboxError {
  const uniquePaths = [...new Set(input.paths)]
  const paths = uniquePaths.slice(0, 100)
  const details = safeDetails({
    pathCount: uniquePaths.length,
    pathsTruncated: uniquePaths.length > paths.length,
    conflictsTruncated: input.conflicts.length > 50,
    paths,
    conflicts: input.conflicts.slice(0, 50).map((conflict) => ({
      path: conflict.path,
      kind: conflict.kind,
      sides: [...conflict.sides],
    })),
    nextStep: input.nextStep,
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
  })
  const build = (message: string) =>
    new OcboxError({
      code: 'SYNC_CONFLICT',
      message,
      requestId: input.requestId ?? newRequestId(),
      ...(details === undefined ? {} : { details }),
    })
  try {
    return build(input.message)
  } catch {
    return build(
      paths.length === 0
        ? 'Source sync conflicts with the workspace; run ocbox sync diff and retry'
        : `Source sync conflicts in ${String(paths.length)} path(s); run the command with --json to list them`,
    )
  }
}

/**
 * The server refused a push because the box tree moved. The CLI knows which
 * local paths it was sending; when the v3 check named box edits, their
 * intersection is the both-changed set.
 */
export function pushServerConflict(
  error: OcboxError,
  changedPaths: readonly string[],
  editedPaths: ReadonlySet<string>,
): OcboxError {
  if (error.code !== 'SYNC_CONFLICT') return error
  const unique = [...new Set(changedPaths)].sort(comparePathString)
  const both = unique.filter((path) => editedPaths.has(path))
  const paths = both.length > 0 ? both : unique
  const kind = both.length > 0 ? 'both-changed' : 'workspace-conflict'
  const sides = both.length > 0 ? ['local', 'remote'] : ['local']
  const nextStep = pushExcludeNextStep(paths)
  const reasonCode = error.details?.['reasonCode']
  const message =
    paths.length === 0
      ? `${error.message}. Run ocbox sync diff to inspect the box workspace`
      : both.length > 0
        ? `${error.message}: ${listConflictPaths(paths)} changed on both sides. The box changed since your last push; skip your local changes with: ${nextStep}`
        : `${error.message}. Your locally changed paths are: ${listConflictPaths(paths)}. Run ocbox sync diff to see the box side, or skip them with: ${nextStep}`
  return syncConflictError({
    message,
    paths,
    conflicts: paths.map((path) => ({ path, kind, sides })),
    nextStep,
    requestId: error.requestId,
    ...(typeof reasonCode === 'string' ? { reasonCode } : {}),
  })
}

/** The tree as the client sees it, before content is packed into blobs. */
function sourceFiles(source: SourceManifest): CasFile[] {
  return source.entries
    .filter((entry) => entry.exclusionReason === null)
    .map((entry) =>
      entry.type === 'directory'
        ? { path: entry.path, type: 'directory' }
        : {
            path: entry.path,
            type: 'file',
            hash: entry.sha256 as string,
            size: entry.size,
            mode: entry.mode & 0o111 ? 493 : 420,
            parts: [],
          },
    )
}

function identity(file: CasFile | undefined): string {
  if (file === undefined) return ''
  return JSON.stringify(
    file.type === 'directory'
      ? [file.path, 'directory']
      : [file.path, 'file', file.hash, file.size, file.mode],
  )
}

function fastTransportOf(transport: SyncContext['casTransport']): CasFastTransport | undefined {
  return transport !== undefined &&
    transport.check !== undefined &&
    transport.fastApply !== undefined
    ? (transport as CasFastTransport)
    : undefined
}

function unchangedView(context: SyncContext, firstSync: boolean): SyncApplyView {
  return {
    schemaVersion: 1,
    mode: 'push',
    sessionId: context.sessionId,
    firstSync,
    additions: [],
    modifications: [],
    deletions: [],
    renames: [],
    conflicts: [],
    operations: [],
    blocked: [],
    collisions: [],
    excluded: [],
    requiresDeletionApproval: false,
    applied: true,
    baselineUpdated: true,
    operationId: null,
    uploadedBlobs: 0,
    uploadedBytes: 0,
    protocolVersion: 2,
  }
}

/** Workspace/root/API scoped unsigned state; the outer service owns the Session lock. */
export async function runCasPush(
  context: SyncContext,
  options: SyncApplyOptions,
): Promise<SyncApplyView> {
  const transport = context.casTransport
  if (!transport) throw casError('CAPABILITY_UNSUPPORTED', 'Source sync v2 is unavailable')
  const fast = fastTransportOf(transport)
  const { statePath, pendingPath, cache } = casStatePaths(context, transport.scope)
  // Exclude the state subtree before it is created or read. This is an exact path,
  // outside user-rule precedence, so --include cannot transfer source caches.
  const stateRelative = relative(context.localRoot, context.stateDirectory).split(sep).join('/')
  if (!stateRelative)
    throw casError('CONFIG_INVALID', 'The state directory must differ from the source root')
  const statePaths =
    !isAbsolute(stateRelative) && stateRelative !== '..' && !stateRelative.startsWith('../')
      ? [stateRelative]
      : []
  const excludePaths = ['.ocb', '.ocb-cas-owned.json', ...statePaths]
  options.onProgress?.({ phase: 'scan' })
  let groups: Awaited<ReturnType<typeof loadIgnoreRuleGroups>>
  try {
    groups = await loadIgnoreRuleGroups(context.localRoot, options.cliRules)
  } catch (error) {
    if (error instanceof InvalidIgnoreRuleError)
      throw casError('CONFIG_INVALID', 'A source ignore file contains an invalid rule')
    throw casError('CONFIG_INVALID', 'Source ignore files could not be read')
  }
  let source: Awaited<ReturnType<typeof scanSourceManifest>>
  try {
    source = await scanSourceManifest(context.localRoot, { ignoreRuleGroups: groups, excludePaths })
  } catch {
    throw casError('CONFIG_INVALID', 'The source root must be a readable directory without links')
  }
  if (source.blocked.length || source.blockedOverflow || source.collisions.length) {
    const sizeOnly =
      !source.collisions.length &&
      !source.blockedOverflow &&
      source.blocked.every((e) => ['entry-limit', 'file-limit', 'size-limit'].includes(e.reason))
    throw casError(
      sizeOnly ? 'SYNC_TOO_LARGE' : 'SYNC_CONFLICT',
      'Source contains unsupported paths or exceeds sync limits; nothing was transferred',
    )
  }
  const previous = await readCasState(statePath),
    pending = await readCasState(pendingPath)
  const old = new Map(previous?.pages.flatMap((p) => p.files).map((f) => [f.path, f]))
  const currentFiles = sourceFiles(source)
  const current = new Map(currentFiles.map((file) => [file.path, file]))
  // An excluded path still present locally means "leave it alone", not "delete
  // it from the box". That makes `--exclude <conflicting path>` a safe way out.
  const excludedPaths = new Set(
    source.entries.filter((entry) => entry.exclusionReason !== null).map((entry) => entry.path),
  )
  const changedPaths = [...new Set([...old.keys(), ...current.keys()])]
    .filter((path) => identity(old.get(path)) !== identity(current.get(path)))
    .sort()
  const deletedPaths: ManifestPath[] = []
  for (const path of [...old.keys()].filter((path) => !current.has(path)).sort()) {
    if (excludedPaths.has(path)) continue
    const entry = old.get(path)
    if (entry !== undefined) {
      const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      const reason = await sourceExclusionForPath(
        groups,
        folder,
        entry.path,
        entry.type === 'directory',
      )
      if (reason !== null) continue
    }
    deletedPaths.push(path)
  }
  const fingerprint = casTreeFingerprint(currentFiles)

  // The v3 check is read-only: an unchanged tree stops here without a plan,
  // upload or apply. A server without the route falls through to the v2 path.
  let editedPaths = new Set<string>()
  if (fast !== undefined) {
    try {
      const answer = await fast.check(
        fingerprint,
        changedPaths.length <= 1024 ? changedPaths : undefined,
        `cas-check-${fingerprint}`,
      )
      editedPaths = new Set(answer.editedPaths)
      if (answer.state === 'unchanged') {
        await saveHostedBaseline(context, snapshotEntries(source), options.now)
        options.onProgress?.({ phase: 'complete', uploadedBlobs: 0, uploadedBytes: 0 })
        return unchangedView(context, previous === undefined)
      }
    } catch (error) {
      if (error instanceof OcboxError && error.code === 'SYNC_CONFLICT')
        throw pushServerConflict(error, changedPaths, editedPaths)
      if (
        !(error instanceof OcboxError) ||
        error.code !== 'CAPABILITY_UNSUPPORTED' ||
        isCliOutdatedError(error)
      )
        throw error
    }
  }

  const deletions = deletedPaths.map((path) => ({
    side: 'remote',
    kind: old.get(path)?.type ?? 'file',
    path,
  }))
  if (
    deletions.length &&
    (!options.delete || (!options.yes && (!options.interactive || !(await options.confirm()))))
  ) {
    throw syncConflictError({
      message: `Removing previously synced paths requires --delete and confirmation (or --yes): ${listConflictPaths(deletedPaths)}`,
      paths: deletedPaths,
      conflicts: deletedPaths.map((path) => ({
        path,
        kind: 'deletion',
        sides: ['local'],
      })),
      nextStep: 'ocbox sync push --delete --yes',
    })
  }

  await prepareCasDirectory(cache)
  const snapshot = await buildCasSnapshot(context.localRoot, cache, source, pending ?? previous)
  const files = snapshot.pages.flatMap((p) => p.files),
    currentSnapshot = new Map(files.map((f) => [f.path, f]))
  // Pending identity survives response loss only when the current pages are identical.
  if (
    pending &&
    Date.now() - pending.createdAt < 45 * 60_000 &&
    JSON.stringify(snapshot.manifest.pageHashes) === JSON.stringify(pending.manifest.pageHashes)
  ) {
    snapshot.manifest.syncId = pending.manifest.syncId
    snapshot.createdAt = pending.createdAt
  }
  await writeCasState(pendingPath, snapshot)
  options.onProgress?.({ phase: 'prepared', files: files.length, pages: snapshot.pages.length })

  // A local change that fits one v3 delta request takes the fast apply. A box
  // with no applied record refuses it with manifest_invalid, so fall back to
  // the full v2 cycle instead of failing the push.
  if (fast !== undefined && previous !== undefined && changedPaths.length > 0) {
    const changedFiles = changedPaths
      .map((path) => currentSnapshot.get(path))
      .filter((file): file is CasFile => file !== undefined)
    const blobByHash = new Map(
      snapshot.pages.flatMap((page) => page.blobs).map((blob) => [blob.hash, blob]),
    )
    const needed = new Map<string, CasBlob>()
    for (const file of changedFiles)
      if (file.type === 'file')
        for (const part of file.parts) {
          const blob = blobByHash.get(part.hash)
          if (blob !== undefined) needed.set(blob.hash, blob)
        }
    const blobs = [...needed.values()]
    const requestBytes = Buffer.byteLength(
      JSON.stringify({
        version: 3,
        fingerprint,
        files: changedFiles,
        blobs,
        deletedPaths,
      }),
    )
    if (
      changedFiles.length <= 512 &&
      deletedPaths.length <= 1024 &&
      blobs.length <= CAS_LIMITS.maxBlobs &&
      requestBytes <= CAS_LIMITS.maxPageBytes + 32_768
    ) {
      try {
        const result = await fastApplyCasSnapshot(
          { fingerprint, files: changedFiles, blobs, deletedPaths },
          cache,
          fast,
          { signal: context.signal, onProgress: options.onProgress },
        )
        await writeCasState(statePath, snapshot)
        await rm(pendingPath, { force: true })
        await saveHostedBaseline(context, snapshotEntries(source), options.now)
        return {
          schemaVersion: 1,
          mode: 'push',
          sessionId: context.sessionId,
          firstSync: previous === undefined,
          additions: changedFiles
            .filter((file) => !old.has(file.path))
            .map((file) => ({ side: 'local', kind: file.type, path: file.path })),
          modifications: changedFiles
            .filter((file) => old.has(file.path))
            .map((file) => ({ side: 'local', kind: file.type, path: file.path })),
          deletions,
          renames: [],
          conflicts: [],
          operations: [],
          blocked: [],
          collisions: [],
          excluded: [],
          requiresDeletionApproval: deletions.length > 0,
          applied: true,
          baselineUpdated: true,
          operationId: null,
          uploadedFiles: changedFiles
            .filter((file) => file.type === 'file')
            .map((file) => file.path),
          uploadedFileBytes: changedFiles
            .filter((file) => file.type === 'file')
            .reduce((total, file) => total + file.size, 0),
          uploadedBlobs: result.uploadedBlobs,
          uploadedBytes: result.uploadedBytes,
          protocolVersion: 2,
        }
      } catch (error) {
        if (error instanceof OcboxError && error.code === 'SYNC_CONFLICT')
          throw pushServerConflict(error, changedPaths, editedPaths)
        const fallback =
          (error instanceof CasPlanRefused && error.code === 'SYNC_INTEGRITY') ||
          (error instanceof OcboxError &&
            error.code === 'CAPABILITY_UNSUPPORTED' &&
            !isCliOutdatedError(error))
        if (!fallback) throw error
      }
    }
  }

  let result: Awaited<ReturnType<typeof syncCasSnapshot>>
  try {
    result = await syncCasSnapshot(snapshot, cache, transport, {
      signal: context.signal,
      onProgress: options.onProgress,
    })
  } catch (error) {
    if (context.signal?.aborted)
      throw casError('OPERATION_CANCELLED', 'Source sync was cancelled; rerun push to resume')
    if (error instanceof CasPlanRefused) await rm(pendingPath, { force: true })
    if (error instanceof OcboxError && error.code === 'SYNC_CONFLICT')
      throw pushServerConflict(error, changedPaths, editedPaths)
    if (error instanceof OcboxError) throw error
    throw casError('SYNC_FAILED', 'Source sync was interrupted; rerun push to resume')
  }
  await writeCasState(statePath, snapshot)
  await rm(pendingPath, { force: true })
  await saveHostedBaseline(context, snapshotEntries(source), options.now)
  const changed = files.filter((f) => {
    const before = old.get(f.path)
    return JSON.stringify(before) !== JSON.stringify(f)
  })
  return {
    schemaVersion: 1,
    mode: 'push',
    sessionId: context.sessionId,
    firstSync: !previous,
    additions: changed
      .filter((f) => !old.has(f.path))
      .map((f) => ({ side: 'local', kind: f.type, path: f.path })),
    modifications: changed
      .filter((f) => old.has(f.path))
      .map((f) => ({ side: 'local', kind: f.type, path: f.path })),
    deletions,
    renames: [],
    conflicts: [],
    operations: [],
    blocked: [],
    collisions: [],
    excluded: [],
    requiresDeletionApproval: deletions.length > 0,
    applied: true,
    baselineUpdated: true,
    operationId: result.planId,
    uploadedFiles: changed.filter((f) => f.type === 'file').map((f) => f.path),
    uploadedFileBytes: changed
      .filter((f) => f.type === 'file')
      .reduce((total, file) => total + file.size, 0),
    uploadedBlobs: result.uploadedBlobs,
    uploadedBytes: result.uploadedBytes,
    protocolVersion: 2,
  }
}

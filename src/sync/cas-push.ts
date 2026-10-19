import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { CasPlanRefused } from '../providers/ocbox/cas.js'
import { OcboxError } from '../errors/index.js'
import { InvalidIgnoreRuleError } from './exclusions.js'
import { loadIgnoreRuleGroups } from './ignore-rules.js'
import { scanSourceManifest } from './manifest.js'
import {
  buildCasSnapshot,
  casError,
  prepareCasDirectory,
  readCasState,
  writeCasState,
} from './cas-snapshot.js'
import { syncCasSnapshot } from './cas-transfer.js'
import type { SyncApplyOptions, SyncApplyView, SyncContext } from './service.js'

/** Workspace/root/API scoped unsigned state; the outer service owns the Session lock. */
export async function runCasPush(
  context: SyncContext,
  options: SyncApplyOptions,
): Promise<SyncApplyView> {
  const transport = context.casTransport
  if (!transport) throw casError('CAPABILITY_UNSUPPORTED', 'Source sync v2 is unavailable')
  const key = createHash('sha256')
    .update(JSON.stringify([transport.scope, context.localRoot]))
    .digest('hex')
  const directory = join(
    context.stateDirectory,
    'sync',
    context.projectId,
    context.sessionId,
    'cas',
    key,
  )
  const statePath = join(directory, 'state.json'),
    pendingPath = join(directory, 'pending.json'),
    cache = join(directory, 'blobs')
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
  await prepareCasDirectory(cache)
  const previous = await readCasState(statePath),
    pending = await readCasState(pendingPath)
  const snapshot = await buildCasSnapshot(context.localRoot, cache, source, pending ?? previous)
  const old = new Map(previous?.pages.flatMap((p) => p.files).map((f) => [f.path, f]))
  const files = snapshot.pages.flatMap((p) => p.files),
    current = new Map(files.map((f) => [f.path, f]))
  const deletions = [...old.values()]
    .filter((f) => !current.has(f.path))
    .map((f) => ({ side: 'remote', kind: f.type, path: f.path }))
  if (
    deletions.length &&
    (!options.delete || (!options.yes && (!options.interactive || !(await options.confirm()))))
  ) {
    throw casError(
      'SYNC_CONFLICT',
      'Removing previously synced paths requires --delete and confirmation (or --yes)',
    )
  }
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
    if (error instanceof OcboxError) throw error
    throw casError('SYNC_FAILED', 'Source sync was interrupted; rerun push to resume')
  }
  await writeCasState(statePath, snapshot)
  await rm(pendingPath, { force: true })
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
    baselineUpdated: false,
    operationId: result.planId,
    uploadedFiles: changed.filter((f) => f.type === 'file').map((f) => f.path),
    uploadedBlobs: result.uploadedBlobs,
    uploadedBytes: result.uploadedBytes,
    protocolVersion: 2,
  }
}

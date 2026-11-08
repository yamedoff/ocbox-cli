import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { OcboxError } from '../errors/index.js'
import { CasPlanRefused } from '../providers/ocbox/cas.js'
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
import { loadIgnoreRuleGroups } from './ignore-rules.js'
import { type SourceManifest, scanSourceManifest } from './manifest.js'
import type { SyncApplyOptions, SyncApplyView, SyncContext } from './service.js'

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
    baselineUpdated: false,
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
  const previous = await readCasState(statePath),
    pending = await readCasState(pendingPath)
  const old = new Map(previous?.pages.flatMap((p) => p.files).map((f) => [f.path, f]))
  const currentFiles = sourceFiles(source)
  const current = new Map(currentFiles.map((file) => [file.path, file]))
  const changedPaths = [...new Set([...old.keys(), ...current.keys()])]
    .filter((path) => identity(old.get(path)) !== identity(current.get(path)))
    .sort()
  const deletedPaths = [...old.keys()].filter((path) => !current.has(path)).sort()
  const fingerprint = casTreeFingerprint(currentFiles)

  // The v3 check is read-only: an unchanged tree stops here without a plan,
  // upload or apply. A server without the route falls through to the v2 path.
  if (fast !== undefined) {
    try {
      const answer = await fast.check(
        fingerprint,
        changedPaths.length <= 1024 ? changedPaths : undefined,
        `cas-check-${fingerprint}`,
      )
      if (answer.state === 'unchanged') {
        options.onProgress?.({ phase: 'complete', uploadedBlobs: 0, uploadedBytes: 0 })
        return unchangedView(context, previous === undefined)
      }
    } catch (error) {
      if (!(error instanceof OcboxError) || error.code !== 'CAPABILITY_UNSUPPORTED') throw error
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
    throw casError(
      'SYNC_CONFLICT',
      'Removing previously synced paths requires --delete and confirmation (or --yes)',
    )
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
          baselineUpdated: false,
          operationId: null,
          uploadedFiles: changedFiles
            .filter((file) => file.type === 'file')
            .map((file) => file.path),
          uploadedBlobs: result.uploadedBlobs,
          uploadedBytes: result.uploadedBytes,
          protocolVersion: 2,
        }
      } catch (error) {
        const fallback =
          (error instanceof CasPlanRefused && error.code === 'SYNC_INTEGRITY') ||
          (error instanceof OcboxError && error.code === 'CAPABILITY_UNSUPPORTED')
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

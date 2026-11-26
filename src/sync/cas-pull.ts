import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { UtcTimestampSchema } from '../domain/timestamps.js'
import { OcboxError } from '../errors/index.js'
import { casRefusal } from '../providers/ocbox/cas.js'
import { sleepWithSignal } from '../providers/ocbox/retry.js'
import {
  snapshotEntries,
  snapshotSha256,
  type SyncBaselineEvidence,
  type SyncSnapshotEntry,
  VerifiedSyncBaselineSchema,
} from './baseline.js'
import { SyncBaselineStore, SyncBaselineStoreError } from './baseline-store.js'
import {
  CAS_LIMITS,
  CasManifestSchema,
  CasPageSchema,
  type CasFile,
  type CasManifest,
  type CasPage,
  type CasPullResult,
  type CasReadTransport,
  validateCasPages,
} from './cas-contract.js'
import {
  casStatePaths,
  listConflictPaths,
  saveHostedBaseline,
  syncConflictError,
  type SyncConflictReport,
} from './cas-push.js'
import { casError, readCasState } from './cas-snapshot.js'
import { loadIgnoreRuleGroups } from './ignore-rules.js'
import { scanSourceManifest } from './manifest.js'
import {
  planSync,
  type SyncChange,
  type SyncConflict,
  type SyncPlan,
  type SyncRename,
} from './planner.js'
import type {
  SyncApplyOptions,
  SyncApplyView,
  SyncChangeView,
  SyncConflictView,
  SyncContext,
  SyncDiffOptions,
  SyncOperationView,
  SyncPlanView,
  SyncRenameView,
} from './service.js'

type FileEntry = Extract<CasFile, { type: 'file' }>

interface SnapshotBundle {
  readonly snapshotId: string
  readonly manifest: CasManifest
  readonly pages: CasPage[]
}

interface TreeDiff {
  readonly additions: readonly SyncSnapshotEntry[]
  readonly modifications: readonly SyncSnapshotEntry[]
  readonly deletions: readonly SyncSnapshotEntry[]
}

interface PulledBlobs {
  readonly pullId: string
  readonly blobs: ReadonlyMap<string, { hash: string; size: number; url: string }>
}

interface StagedFile {
  readonly temp: string
  readonly target: string
}

function comparePath(left: { path: string }, right: { path: string }): number {
  return Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'))
}

function comparePathString(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function sameEntry(
  left: SyncSnapshotEntry | undefined,
  right: SyncSnapshotEntry | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return (
    left.path === right.path &&
    left.type === right.type &&
    left.size === right.size &&
    left.sha256 === right.sha256 &&
    left.mode === right.mode &&
    left.linkTarget === right.linkTarget
  )
}

/**
 * The hosted three-way baseline: the verified store written by push/pull, or
 * the last pushed CAS state for a workspace that predates it. Without either,
 * the first pull keeps the old two-way behaviour.
 */
async function loadHostedBaseline(context: SyncContext): Promise<SyncBaselineEvidence | null> {
  try {
    const stored = await new SyncBaselineStore(
      context.stateDirectory,
      context.projectId,
      context.sessionId,
    ).load()
    if (stored !== null) return stored
  } catch (error) {
    if (error instanceof SyncBaselineStoreError && error.code === 'UNSAFE_BASELINE')
      throw casError(
        'SYNC_CONFLICT',
        'The verified baseline would persist secret-like material; refusing to sync',
      )
    throw casError(
      'SYNC_INTEGRITY',
      'The stored sync baseline is unreadable; resolve it before syncing again',
    )
  }
  const transport = context.casTransport
  if (transport === undefined) return null
  const snapshot = await readCasState(casStatePaths(context, transport.scope).statePath)
  if (snapshot === undefined) return null
  const entries = remoteEntries(snapshot.pages)
  return VerifiedSyncBaselineSchema.parse({
    schemaVersion: 1,
    verified: true,
    verifiedAt: UtcTimestampSchema.parse(new Date(snapshot.createdAt).toISOString()),
    snapshotSha256: snapshotSha256(entries),
    entries,
  })
}

/**
 * A pull must only write paths the box changed since the baseline. Projecting
 * a locally changed (or locally deleted) path back to its baseline entry keeps
 * the real planner from treating an untouched box path as a conflict; paths the
 * box did change keep the real local entry, so a local edit there conflicts.
 */
function projectLocalForPull(
  local: readonly SyncSnapshotEntry[],
  remote: readonly SyncSnapshotEntry[],
  baseline: Extract<SyncBaselineEvidence, { verified: true }>,
): SyncSnapshotEntry[] {
  const localMap = new Map(local.map((entry) => [entry.path, entry]))
  const remoteMap = new Map(remote.map((entry) => [entry.path, entry]))
  const baselineMap = new Map(baseline.entries.map((entry) => [entry.path, entry]))
  const projected: SyncSnapshotEntry[] = []
  for (const path of new Set([...baselineMap.keys(), ...remoteMap.keys()])) {
    const before = baselineMap.get(path)
    const after = remoteMap.get(path)
    if (sameEntry(before, after)) {
      if (before !== undefined) projected.push(before)
    } else {
      const current = localMap.get(path)
      if (current !== undefined) projected.push(current)
    }
  }
  return projected.sort(comparePath)
}

function conflictSides(plan: SyncPlan, conflict: SyncConflict): readonly string[] {
  const paths = new Set(
    conflict.relatedPaths.length > 0
      ? conflict.relatedPaths
      : conflict.path === null
        ? []
        : [conflict.path],
  )
  const sides = new Set<string>()
  for (const change of [...plan.additions, ...plan.modifications, ...plan.deletions]) {
    if (paths.has(change.path)) sides.add(change.side)
  }
  return [...sides].sort()
}

function conflictView(plan: SyncPlan, conflict: SyncConflict): SyncConflictView {
  return {
    kind: conflict.kind,
    path: conflict.path,
    relatedPaths: [...conflict.relatedPaths],
    sides: conflictSides(plan, conflict),
  }
}

function conflictReports(plan: SyncPlan): SyncConflictReport[] {
  return plan.conflicts.map((conflict) => ({
    path: conflict.path,
    kind: conflict.kind,
    sides: conflictSides(plan, conflict),
  }))
}

function conflictPaths(plan: SyncPlan): string[] {
  return [
    ...new Set(
      plan.conflicts.flatMap((conflict) =>
        conflict.relatedPaths.length > 0
          ? conflict.relatedPaths
          : conflict.path === null
            ? []
            : [conflict.path],
      ),
    ),
  ].sort(comparePathString)
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

function planViewFromPlan(
  context: SyncContext,
  mode: 'diff' | 'pull',
  plan: SyncPlan,
  diff: TreeDiff,
  conflicts: readonly SyncConflict[] = plan.conflicts,
  skipped: ReadonlySet<string> = new Set(),
): SyncPlanView {
  const visible = [...plan.additions, ...plan.modifications].filter(
    (change) => change.side === 'remote' && !skipped.has(change.path),
  )
  const additions = mode === 'diff' ? plan.additions : visible.filter((c) => c.kind === 'addition')
  const modifications =
    mode === 'diff' ? plan.modifications : visible.filter((c) => c.kind === 'modification')
  const deletions: SyncChangeView[] =
    mode === 'diff'
      ? plan.deletions.map(changeView)
      : diff.deletions
          .filter((entry) => !skipped.has(entry.path))
          .map((entry) => ({ side: 'local', kind: 'deletion', path: entry.path }))
  return {
    schemaVersion: 1,
    mode,
    sessionId: context.sessionId,
    firstSync: false,
    additions: additions.map(changeView),
    modifications: modifications.map(changeView),
    deletions,
    renames:
      mode === 'diff'
        ? plan.renames.map(renameView)
        : plan.renames.filter((rename) => rename.side === 'remote').map(renameView),
    conflicts: conflicts.map((conflict) => conflictView(plan, conflict)),
    operations: plan.operations.map(
      (operation): SyncOperationView => ({
        kind: operation.kind,
        source: operation.source,
        path: operation.path,
        fromPath: operation.fromPath,
      }),
    ),
    requiresDeletionApproval: deletions.length > 0,
    blocked: [],
    collisions: [],
    excluded: [],
  }
}

function pauseFor(
  pause: ((milliseconds: number) => Promise<void>) | undefined,
  signal: AbortSignal | undefined,
): (milliseconds: number) => Promise<void> {
  return pause ?? ((milliseconds) => sleepWithSignal(milliseconds, signal))
}

function integrity(message: string): OcboxError {
  return casError('SYNC_INTEGRITY', message)
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path)
    return metadata.isDirectory() && !metadata.isSymbolicLink()
  } catch {
    return false
  }
}

async function scanLocal(
  context: SyncContext,
  cliRules: SyncDiffOptions['cliRules'],
): Promise<readonly SyncSnapshotEntry[]> {
  if (!(await isDirectory(context.localRoot))) return []
  const groups = await loadIgnoreRuleGroups(context.localRoot, cliRules)
  const manifest = await scanSourceManifest(context.localRoot, { ignoreRuleGroups: groups })
  return snapshotEntries(manifest)
}

function remoteEntries(pages: readonly CasPage[]): readonly SyncSnapshotEntry[] {
  return pages
    .flatMap((page) => page.files)
    .map(
      (entry): SyncSnapshotEntry =>
        entry.type === 'directory'
          ? {
              path: entry.path,
              type: 'directory',
              size: 0,
              sha256: null,
              mode: 0o755,
              linkTarget: null,
            }
          : {
              path: entry.path,
              type: 'file',
              size: entry.size,
              sha256: entry.hash,
              mode: entry.mode,
              linkTarget: null,
            },
    )
    .sort(comparePath)
}

/** The local tree is the target: additions and edits come from the box, removals are local. */
function diffTrees(
  local: readonly SyncSnapshotEntry[],
  remote: readonly SyncSnapshotEntry[],
): TreeDiff {
  const localByPath = new Map(local.map((entry) => [entry.path, entry]))
  const remoteByPath = new Map(remote.map((entry) => [entry.path, entry]))
  const paths = [...new Set([...localByPath.keys(), ...remoteByPath.keys()])].sort(
    comparePathString,
  )
  const additions: SyncSnapshotEntry[] = []
  const modifications: SyncSnapshotEntry[] = []
  const deletions: SyncSnapshotEntry[] = []
  for (const path of paths) {
    const localEntry = localByPath.get(path)
    const remoteEntry = remoteByPath.get(path)
    if (localEntry === undefined && remoteEntry !== undefined) {
      additions.push(remoteEntry)
      continue
    }
    if (localEntry !== undefined && remoteEntry === undefined) {
      deletions.push(localEntry)
      continue
    }
    if (localEntry === undefined || remoteEntry === undefined) continue
    if (localEntry.type !== remoteEntry.type) {
      modifications.push(remoteEntry)
      continue
    }
    if (
      remoteEntry.type === 'file' &&
      (localEntry.size !== remoteEntry.size || localEntry.sha256 !== remoteEntry.sha256)
    ) {
      modifications.push(remoteEntry)
    }
  }
  return { additions, modifications, deletions }
}

function planView(context: SyncContext, mode: 'diff' | 'pull', diff: TreeDiff): SyncPlanView {
  return {
    schemaVersion: 1,
    mode,
    sessionId: context.sessionId,
    firstSync: false,
    additions: diff.additions.map((entry) => ({
      side: 'remote',
      kind: entry.type,
      path: entry.path,
    })),
    modifications: diff.modifications.map((entry) => ({
      side: 'remote',
      kind: entry.type,
      path: entry.path,
    })),
    deletions: diff.deletions.map((entry) => ({
      side: 'local',
      kind: entry.type,
      path: entry.path,
    })),
    renames: [],
    conflicts: [],
    operations: [],
    requiresDeletionApproval: diff.deletions.length > 0,
    blocked: [],
    collisions: [],
    excluded: [],
  }
}

async function readSnapshot(
  transport: CasReadTransport,
  pause: (milliseconds: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<SnapshotBundle> {
  const idempotencyKey = `snapshot-${randomUUID()}`
  const deadline = Date.now() + CAS_LIMITS.applyTimeoutMs
  let result = await transport.snapshot(true, idempotencyKey)
  for (;;) {
    if (result.state === 'succeeded') break
    if (result.state === 'failed') throw casRefusal(200, result.reason, 'snapshot')
    if (Date.now() >= deadline)
      throw casError(
        'OPERATION_TIMEOUT',
        'The source snapshot did not finish in time; retry sync diff',
      )
    await pause(CAS_LIMITS.retryMs)
    if (signal?.aborted)
      throw casError('OPERATION_CANCELLED', 'Source sync was cancelled; retry the command')
    result = await transport.snapshot(true, idempotencyKey)
  }
  try {
    if (result.manifest === undefined || result.page === undefined)
      throw new Error('Snapshot has no manifest page')
    const manifest = CasManifestSchema.parse(result.manifest)
    const pages = [CasPageSchema.parse(result.page)]
    for (let index = 1; index < manifest.pageHashes.length; index += 1) {
      const pageKey = `read-${result.snapshotId}-${String(index)}`
      let page = await transport.snapshotPage(result.snapshotId, index, pageKey)
      while (page.state === 'pending') {
        if (Date.now() >= deadline)
          throw casError(
            'OPERATION_TIMEOUT',
            'The source snapshot did not finish in time; retry sync diff',
          )
        await pause(CAS_LIMITS.retryMs)
        if (signal?.aborted)
          throw casError('OPERATION_CANCELLED', 'Source sync was cancelled; retry the command')
        page = await transport.snapshotPage(result.snapshotId, index, pageKey)
      }
      if (page.state === 'failed') throw casRefusal(200, page.reason, 'snapshot-page')
      if (page.page === undefined) throw new Error('Snapshot page is missing')
      pages.push(CasPageSchema.parse(page.page))
    }
    validateCasPages(manifest, pages)
    return { snapshotId: result.snapshotId, manifest, pages }
  } catch (error) {
    if (error instanceof OcboxError) throw error
    throw integrity('The source snapshot did not match the public contract; nothing was written')
  }
}

function readTarget(input: string): string {
  try {
    const url = new URL(input)
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    )
      throw new Error()
    return input
  } catch {
    throw integrity('Source pull returned an invalid download capability; nothing was written')
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function downloadBlob(
  blob: { hash: string; size: number; url: string },
  pause: (milliseconds: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const url = readTarget(blob.url)
  for (let attempt = 1; ; attempt += 1) {
    let response: Response | undefined
    let bytes: Buffer | undefined
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(CAS_LIMITS.uploadTimeoutMs)])
          : AbortSignal.timeout(CAS_LIMITS.uploadTimeoutMs),
      })
      bytes = Buffer.from(await response.arrayBuffer())
    } catch {
      /* retry without exposing the capability or transport diagnostics */
    }
    if (response?.ok === true && bytes !== undefined) {
      if (bytes.length !== blob.size || sha256(bytes) !== blob.hash)
        throw integrity('A pulled file failed hash verification; nothing was written')
      return bytes
    }
    if (response && response.status !== 429 && response.status < 500)
      throw casError('SYNC_FAILED', 'The source pull download was refused; retry sync pull')
    if (attempt >= CAS_LIMITS.attempts)
      throw casError('SYNC_FAILED', 'The source pull download failed; retry sync pull')
    await pause(CAS_LIMITS.retryMs * 2 ** (attempt - 1))
    if (signal?.aborted)
      throw casError('OPERATION_CANCELLED', 'Source sync was cancelled; retry the command')
  }
}

async function pullBlobs(
  transport: CasReadTransport,
  snapshotId: string,
  files: readonly FileEntry[],
  pause: (milliseconds: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<PulledBlobs> {
  const idempotencyKey = `pull-${randomUUID()}`
  const paths = files.map((file) => file.path).sort(comparePathString)
  const deadline = Date.now() + CAS_LIMITS.applyTimeoutMs
  const blobs = new Map<string, { hash: string; size: number; url: string }>()
  let pullId: string | undefined
  let cursor: string | undefined
  for (let pageCount = 0; pageCount < CAS_LIMITS.maxPages; pageCount += 1) {
    let result: CasPullResult = await transport.pull(snapshotId, paths, idempotencyKey, cursor)
    for (;;) {
      if (result.state === 'succeeded') break
      if (result.state === 'failed') throw casRefusal(200, result.reason, 'pull')
      if (Date.now() >= deadline)
        throw casError(
          'OPERATION_TIMEOUT',
          'The source pull did not finish in time; retry sync pull',
        )
      await pause(CAS_LIMITS.retryMs)
      if (signal?.aborted)
        throw casError('OPERATION_CANCELLED', 'Source sync was cancelled; retry the command')
      result = await transport.pull(snapshotId, paths, idempotencyKey, cursor)
    }
    if (result.snapshotId !== snapshotId)
      throw integrity('Source pull receipt did not match its snapshot')
    if (pullId !== undefined && pullId !== result.pullId)
      throw integrity('Source pull receipt did not match its pull')
    pullId = result.pullId
    for (const blob of result.blobs ?? []) {
      const previous = blobs.get(blob.hash)
      if (previous !== undefined && previous.size !== blob.size)
        throw integrity('Source pull returned one blob with two sizes')
      blobs.set(blob.hash, { hash: blob.hash, size: blob.size, url: blob.url })
    }
    if (result.nextCursor === null || result.nextCursor === undefined) return { pullId, blobs }
    cursor = result.nextCursor
  }
  throw integrity('Source pull returned too many capability pages')
}

function targetPath(root: string, path: string): string {
  const candidate = join(root, ...path.split('/'))
  const rel = relative(root, candidate)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw casError('SYNC_CONFLICT', 'A pulled path escapes the local target root')
  return candidate
}

async function assertWritableTarget(target: string): Promise<void> {
  try {
    const metadata = await lstat(target)
    if (metadata.isSymbolicLink())
      throw casError('SYNC_CONFLICT', 'A pulled path is a symlink and was not dereferenced')
    if (metadata.isDirectory())
      throw casError('SYNC_CONFLICT', 'A pulled file collides with a local directory')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

async function stageFile(
  root: string,
  file: FileEntry,
  blobs: ReadonlyMap<string, { hash: string; size: number; url: string }>,
  bytesByHash: ReadonlyMap<string, Buffer>,
): Promise<StagedFile> {
  const target = targetPath(root, file.path)
  await assertWritableTarget(target)
  await mkdir(dirname(target), { recursive: true, mode: 0o755 })
  const temp = join(dirname(target), `.ocb-pull-${randomUUID()}.tmp`)
  try {
    const handle = await open(temp, 'wx', 0o600)
    const digest = createHash('sha256')
    let written = 0
    try {
      for (const part of file.parts) {
        const blob = blobs.get(part.hash)
        const bytes = bytesByHash.get(part.hash)
        if (blob === undefined || bytes === undefined)
          throw integrity('Source pull did not return a declared file part')
        if (part.offset + part.size > bytes.length || bytes.length !== blob.size)
          throw integrity('A pulled file part did not match its declared size')
        const slice = bytes.subarray(part.offset, part.offset + part.size)
        digest.update(slice)
        written += slice.length
        let offset = 0
        while (offset < slice.length) {
          const result = await handle.write(slice, offset, slice.length - offset)
          if (result.bytesWritten <= 0) throw integrity('The pulled file could not be written')
          offset += result.bytesWritten
        }
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (written !== file.size || digest.digest('hex') !== file.hash)
      throw integrity('A pulled file failed hash verification; nothing was written')
    await chmod(temp, file.mode)
    return { temp, target }
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

async function stageFiles(
  root: string,
  files: readonly FileEntry[],
  blobs: ReadonlyMap<string, { hash: string; size: number; url: string }>,
  bytesByHash: ReadonlyMap<string, Buffer>,
): Promise<StagedFile[]> {
  const staged: StagedFile[] = []
  try {
    for (const file of files) staged.push(await stageFile(root, file, blobs, bytesByHash))
    return staged
  } catch (error) {
    await Promise.all(staged.map((entry) => rm(entry.temp, { force: true })))
    throw error
  }
}

async function commitStaged(staged: readonly StagedFile[]): Promise<void> {
  try {
    for (const entry of staged) await rename(entry.temp, entry.target)
  } catch (error) {
    await Promise.all(staged.map((entry) => rm(entry.temp, { force: true })))
    throw error
  }
}

function deletionConfirmationError(paths: readonly string[]): OcboxError {
  return syncConflictError({
    message: `Destructive sync requires interactive confirmation or an explicit --yes acknowledgement: ${listConflictPaths(paths)}`,
    paths,
    conflicts: paths.map((path) => ({ path, kind: 'deletion', sides: ['local'] })),
    nextStep: 'ocbox sync pull --delete --yes',
  })
}

function pullConflictError(
  plan: SyncPlan,
  remote: ReadonlyMap<string, SyncSnapshotEntry>,
): OcboxError {
  const paths = conflictPaths(plan)
  const boxDeletion = plan.conflicts.some(
    (conflict) => conflict.path !== null && !remote.has(conflict.path),
  )
  if (paths.length === 0)
    return syncConflictError({
      message:
        'The stored sync baseline is not verified; resolve the baseline before pulling from the box',
      paths: [],
      conflicts: conflictReports(plan),
      nextStep: 'ocbox sync diff',
    })
  const guidance = boxDeletion
    ? 'Keep your copies with ocbox sync pull --keep-local, or accept the box deletions with ocbox sync pull --delete --yes (and use --overwrite-local for box file changes)'
    : 'Keep your copies with ocbox sync pull --keep-local, or take the box copies with ocbox sync pull --overwrite-local'
  return syncConflictError({
    message: `Source pull conflicts in ${String(paths.length)} path(s): ${listConflictPaths(paths)}. ${guidance}.`,
    paths,
    conflicts: conflictReports(plan),
    nextStep: 'ocbox sync pull --keep-local',
  })
}

function pullOverwriteIncompleteError(
  plan: SyncPlan,
  remote: ReadonlyMap<string, SyncSnapshotEntry>,
): OcboxError {
  const unresolved = plan.conflicts.filter(
    (conflict) => conflict.path === null || !remote.has(conflict.path),
  )
  const paths = [
    ...new Set(
      unresolved.flatMap((conflict) =>
        conflict.relatedPaths.length > 0
          ? conflict.relatedPaths
          : conflict.path === null
            ? []
            : [conflict.path],
      ),
    ),
  ].sort(comparePathString)
  return syncConflictError({
    message:
      paths.length === 0
        ? 'The stored sync baseline is not verified; resolve the baseline before pulling from the box'
        : `The box deleted ${String(paths.length)} path(s) you changed: ${listConflictPaths(paths)}. Keep your copies with ocbox sync pull --keep-local, or accept the box deletions with ocbox sync pull --delete --yes.`,
    paths,
    conflicts: unresolved.map((conflict) => ({
      path: conflict.path,
      kind: conflict.kind,
      sides: conflictSides(plan, conflict),
    })),
    nextStep: 'ocbox sync pull --keep-local',
  })
}

async function deleteLocalPaths(
  root: string,
  entries: readonly SyncSnapshotEntry[],
): Promise<readonly string[]> {
  const ordered = [...entries].sort((left, right) => {
    const depth = right.path.split('/').length - left.path.split('/').length
    return depth === 0 ? comparePath(right, left) : depth
  })
  const deleted: string[] = []
  for (const entry of ordered) {
    const target = targetPath(root, entry.path)
    try {
      const metadata = await lstat(target)
      if (metadata.isDirectory()) {
        try {
          await rmdir(target)
          deleted.push(entry.path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') continue
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
      } else {
        await rm(target, { force: true })
        deleted.push(entry.path)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  return deleted
}

export async function runHostedDiff(
  context: SyncContext,
  options: SyncDiffOptions,
): Promise<SyncPlanView> {
  const transport = context.casReadTransport
  if (transport === undefined)
    throw casError('CAPABILITY_UNSUPPORTED', 'Source read-back is unavailable')
  const snapshot = await readSnapshot(
    transport,
    pauseFor(options.pause, context.signal),
    context.signal,
  )
  const local = await scanLocal(context, options.cliRules)
  const remote = remoteEntries(snapshot.pages)
  const diff = diffTrees(local, remote)
  const baseline = await loadHostedBaseline(context)
  if (baseline === null) return planView(context, 'diff', diff)
  const plan = planSync({ mode: 'diff', local, remote, baseline })
  return planViewFromPlan(context, 'diff', plan, diff)
}

export async function runHostedPull(
  context: SyncContext,
  options: SyncApplyOptions,
): Promise<SyncApplyView> {
  if (options.keepLocal === true && options.overwriteLocal === true)
    throw casError('CONFIG_INVALID', 'Use either --keep-local or --overwrite-local, not both')
  const transport = context.casReadTransport
  if (transport === undefined)
    throw casError('CAPABILITY_UNSUPPORTED', 'Source read-back is unavailable')
  if (!(await isDirectory(context.localRoot)))
    throw casError(
      'CONFIG_INVALID',
      'The local target root must be an existing directory, without a symlink',
    )
  const pause = pauseFor(options.pause, context.signal)
  const snapshot = await readSnapshot(transport, pause, context.signal)
  const local = await scanLocal(context, options.cliRules)
  const remote = remoteEntries(snapshot.pages)
  const diff = diffTrees(local, remote)
  const baseline = await loadHostedBaseline(context)

  let selectedPaths: string[]
  let view: SyncPlanView
  let skipped = new Set<string>()
  let deletions: readonly SyncSnapshotEntry[] = diff.deletions

  if (baseline === null) {
    view = planView(context, 'pull', diff)
    selectedPaths = [...diff.additions, ...diff.modifications]
      .filter((entry) => entry.type === 'file')
      .map((entry) => entry.path)
  } else {
    const projected = baseline.verified ? projectLocalForPull(local, remote, baseline) : local
    const plan = planSync({ mode: 'pull', local: projected, remote, baseline })
    const remoteMap = new Map(remote.map((entry) => [entry.path, entry]))
    const localMap = new Map(local.map((entry) => [entry.path, entry]))
    let effectiveConflicts: readonly SyncConflict[] = plan.conflicts
    if (plan.conflicts.length > 0) {
      if (plan.conflicts.some((conflict) => conflict.path === null))
        throw pullConflictError(plan, remoteMap)
      if (options.keepLocal === true) {
        skipped = new Set(conflictPaths(plan))
      } else if (options.overwriteLocal === true) {
        const unverified = plan.conflicts.some((conflict) => conflict.path === null)
        if (unverified) throw pullConflictError(plan, remoteMap)
        const boxDeleted = plan.conflicts.some(
          (conflict) => conflict.path !== null && !remoteMap.has(conflict.path),
        )
        if (boxDeleted && !(options.delete && options.yes))
          throw pullOverwriteIncompleteError(plan, remoteMap)
        effectiveConflicts = []
      } else {
        throw pullConflictError(plan, remoteMap)
      }
    }
    const visible = [...plan.additions, ...plan.modifications].filter((change) => {
      if (change.side !== 'remote' || skipped.has(change.path)) return false
      const entry = remoteMap.get(change.path)
      return entry?.type === 'file' && !sameEntry(localMap.get(change.path), entry)
    })
    selectedPaths = visible.map((change) => change.path)
    deletions = diff.deletions.filter((entry) => !skipped.has(entry.path))
    view = planViewFromPlan(context, 'pull', plan, diff, effectiveConflicts, skipped)
  }

  if (deletions.length > 0 && options.delete && !options.yes) {
    if (!options.interactive || !(await options.confirm()))
      throw deletionConfirmationError(deletions.map((entry) => entry.path))
  }

  const filesByPath = new Map<string, FileEntry>()
  for (const page of snapshot.pages)
    for (const entry of page.files) if (entry.type === 'file') filesByPath.set(entry.path, entry)
  const selected = [...new Set(selectedPaths)]
    .map((path) => filesByPath.get(path))
    .filter((entry): entry is FileEntry => entry !== undefined)
    .sort(comparePath)

  let pullId: string | null = null
  let pulledFiles: readonly string[] = []
  let pulledBytes = 0
  if (selected.length > 0) {
    const pulled = await pullBlobs(transport, snapshot.snapshotId, selected, pause, context.signal)
    pullId = pulled.pullId
    for (const file of selected)
      for (const part of file.parts)
        if (!pulled.blobs.has(part.hash))
          throw integrity('Source pull did not return a declared file part')
    const bytesByHash = new Map<string, Buffer>()
    for (const [hash, blob] of pulled.blobs)
      bytesByHash.set(hash, await downloadBlob(blob, pause, context.signal))
    const staged = await stageFiles(context.localRoot, selected, pulled.blobs, bytesByHash)
    await commitStaged(staged)
    pulledFiles = selected.map((file) => file.path)
    pulledBytes = selected.reduce((total, file) => total + file.size, 0)
  }

  for (const entry of diff.additions.filter(
    (item) => item.type === 'directory' && !skipped.has(item.path),
  )) {
    await mkdir(targetPath(context.localRoot, entry.path), { recursive: true, mode: 0o755 })
  }

  const deletedFiles =
    deletions.length > 0 && options.delete
      ? await deleteLocalPaths(context.localRoot, deletions)
      : []

  await saveHostedBaseline(context, remote, options.now)

  return {
    ...view,
    applied: pulledFiles.length > 0 || deletedFiles.length > 0,
    baselineUpdated: true,
    operationId: pullId,
    protocolVersion: 2,
    pulledFiles,
    pulledBytes,
    deletedFiles,
  }
}

import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { OcboxError } from '../errors/index.js'
import { casRefusal } from '../providers/ocbox/cas.js'
import { sleepWithSignal } from '../providers/ocbox/retry.js'
import { snapshotEntries, type SyncSnapshotEntry } from './baseline.js'
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
import { casError } from './cas-snapshot.js'
import { loadIgnoreRuleGroups } from './ignore-rules.js'
import { scanSourceManifest } from './manifest.js'
import type {
  SyncApplyOptions,
  SyncApplyView,
  SyncContext,
  SyncDiffOptions,
  SyncPlanView,
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
  if (written !== file.size || digest.digest('hex') !== file.hash) {
    await rm(temp, { force: true })
    throw integrity('A pulled file failed hash verification; nothing was written')
  }
  await chmod(temp, file.mode)
  return { temp, target }
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
  for (const entry of staged) await rename(entry.temp, entry.target)
}

function deletionConfirmationError(): OcboxError {
  return casError(
    'SYNC_CONFLICT',
    'Destructive sync requires interactive confirmation or an explicit --yes acknowledgement',
  )
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
  return planView(context, 'diff', diffTrees(local, remoteEntries(snapshot.pages)))
}

export async function runHostedPull(
  context: SyncContext,
  options: SyncApplyOptions,
): Promise<SyncApplyView> {
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
  const diff = diffTrees(local, remoteEntries(snapshot.pages))
  if (diff.deletions.length > 0 && options.delete && !options.yes) {
    if (!options.interactive || !(await options.confirm())) throw deletionConfirmationError()
  }

  const filesByPath = new Map<string, FileEntry>()
  for (const page of snapshot.pages)
    for (const entry of page.files) if (entry.type === 'file') filesByPath.set(entry.path, entry)
  const selected = [...diff.additions, ...diff.modifications]
    .filter((entry): entry is SyncSnapshotEntry & { type: 'file' } => entry.type === 'file')
    .map((entry) => filesByPath.get(entry.path))
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

  for (const entry of diff.additions.filter((item) => item.type === 'directory')) {
    await mkdir(targetPath(context.localRoot, entry.path), { recursive: true, mode: 0o755 })
  }

  const deletedFiles =
    diff.deletions.length > 0 && options.delete
      ? await deleteLocalPaths(context.localRoot, diff.deletions)
      : []

  return {
    ...planView(context, 'pull', diff),
    applied: pulledFiles.length > 0 || deletedFiles.length > 0,
    baselineUpdated: false,
    operationId: pullId,
    protocolVersion: 2,
    pulledFiles,
    pulledBytes,
    deletedFiles,
  }
}

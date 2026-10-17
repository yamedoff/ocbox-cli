import { createHash } from 'node:crypto'
import { lstat, opendir, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { type ExclusionReason, exclusionForPath, type IgnoreRule } from './exclusions.js'
import {
  findPathCollisions,
  hasControlCharacter,
  type ManifestPath,
  ManifestPathSchema,
  normalizeManifestPath,
  type PathCollision,
} from './path-policy.js'

export const MAX_SYNC_BYTES = 1_073_741_824
export const MAX_SYNC_FILES = 100_000
export const MAX_SYNC_FILE_BYTES = 268_435_456
/**
 * Provisional bound on directory entries. The file cap alone does not bound
 * directory-only trees, so this keeps total snapshot memory finite.
 */
export const MAX_SYNC_DIRECTORIES = 100_000
/** Total snapshot entries (files plus directories) accepted by archive/baseline. */
export const MAX_SYNC_ENTRIES = MAX_SYNC_FILES + MAX_SYNC_DIRECTORIES
/**
 * Upper bound on reported blocked entries. Caps only bind transferables, so a
 * hostile tree could otherwise grow `blocked` (and thus snapshot memory)
 * without limit; past this point the overflow flag reports the truncation.
 */
export const MAX_SYNC_BLOCKED = 10_000
/**
 * Number of directory names the scan retains while ordering one listing.
 * Ordering a listing requires holding the names that are still candidates, so
 * this window is the per-directory memory bound: a listing with more children
 * than the window is enumerated in ascending windows, each pass retaining at
 * most this many names, and a directory holding `children` entries costs
 * `ceil(children / MAX_SYNC_LISTING_WINDOW)` streaming passes.
 */
const MAX_SYNC_LISTING_WINDOW = 4_096

export const ManifestEntrySchema = z
  .strictObject({
    path: ManifestPathSchema,
    type: z.enum(['directory', 'file']),
    size: z.number().int().nonnegative().safe(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    mtimeHintNanoseconds: z.string().regex(/^\d+$/),
    mode: z.number().int().min(0).max(0o7777),
    linkTarget: ManifestPathSchema.nullable(),
    exclusionReason: z
      .enum([
        'build-cache',
        'dependency-cache',
        'git-metadata',
        'key-material',
        'os-or-browser-store',
        'provider-credential-store',
        'secret-environment',
        'user-rule',
      ])
      .nullable(),
  })
  .superRefine((entry, context) => {
    if (entry.linkTarget !== null) {
      context.addIssue({
        code: 'custom',
        path: ['linkTarget'],
        message: 'Symlinks are unsupported',
      })
    }
    if (entry.type === 'directory' && (entry.size !== 0 || entry.sha256 !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Directory entries require zero size and no checksum',
      })
    }
    if (entry.type === 'file' && entry.exclusionReason === null && entry.sha256 === null) {
      context.addIssue({
        code: 'custom',
        path: ['sha256'],
        message: 'Transferable files require a checksum',
      })
    }
  })

export type ManifestEntry = z.infer<typeof ManifestEntrySchema>

export interface BlockedSourceEntry {
  readonly path: string
  readonly reason:
    | 'entry-limit'
    | 'file-limit'
    | 'filesystem-race'
    | 'size-limit'
    | 'special-file'
    | 'symlink'
}

export interface SourceManifest {
  readonly schemaVersion: 1
  readonly entries: readonly ManifestEntry[]
  readonly canonicalJsonl: Uint8Array
  readonly manifestSha256: string
  readonly totalBytes: number
  readonly transferableFiles: number
  readonly blocked: readonly BlockedSourceEntry[]
  /** True when blocked entries exceeded `MAX_SYNC_BLOCKED` and were not reported. */
  readonly blockedOverflow: boolean
  readonly collisions: readonly PathCollision[]
}

export interface ScanManifestOptions {
  readonly ignoreRuleGroups?: readonly (readonly IgnoreRule[])[]
  readonly maxBytes?: number
  readonly maxDirectories?: number
  readonly maxFileBytes?: number
  readonly maxFiles?: number
}

export class SourceRootError extends Error {
  constructor() {
    super('Source root must be an absolute, non-link directory')
    this.name = 'SourceRootError'
  }
}

export class SourceManifestBlockedError extends Error {
  constructor(
    readonly blockedCount: number,
    readonly collisionCount: number,
  ) {
    super('Source manifest contains entries that cannot be transferred safely')
    this.name = 'SourceManifestBlockedError'
  }
}

function comparePath(left: { path: string }, right: { path: string }): number {
  return Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'))
}

/** Byte-order comparison for raw directory names, mirroring `comparePath`. */
function compareName(left: string, right: string): number {
  return comparePath({ path: left }, { path: right })
}

function insideRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function safeDisplayPath(raw: string): string {
  let safe = ''
  for (const character of raw) {
    safe += hasControlCharacter(character) ? '\uFFFD' : character
    if (safe.length >= 4_096) break
  }
  return safe.slice(0, 4_096)
}

/**
 * Serializes the mtime hint as integral nanoseconds. Pre-epoch clocks (and a
 * clock that raced the stat read) must not crash the whole scan, so they clamp
 * to the epoch instead; the hint is advisory and excluded from identity hashes.
 */
export function nanosecondMtimeHint(mtimeMs: number): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs < 0) return '0'
  return BigInt(Math.trunc(mtimeMs * 1_000_000)).toString()
}

async function hashStableFile(
  fullPath: string,
  before: Awaited<ReturnType<typeof lstat>>,
): Promise<string | null> {
  const handle = await open(fullPath, 'r')
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      return null
    }
    const hash = createHash('sha256')
    const stream = handle.createReadStream({ autoClose: false })
    for await (const chunk of stream) hash.update(chunk)
    const after = await handle.stat()
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      return null
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/**
 * Merges two ascending name runs, keeping only the smallest
 * `MAX_SYNC_LISTING_WINDOW` names so the retained candidates stay bounded.
 * Both inputs are already truncated to that length, and the smallest names of
 * a union of sorted runs are the first names of their merge.
 */
function boundedMerge(left: readonly string[], right: readonly string[]): string[] {
  const merged: string[] = []
  let leftIndex = 0
  let rightIndex = 0
  while (merged.length < MAX_SYNC_LISTING_WINDOW) {
    const leftName = left[leftIndex]
    const rightName = right[rightIndex]
    if (leftName === undefined) {
      if (rightName === undefined) break
      merged.push(rightName)
      rightIndex += 1
      continue
    }
    if (rightName === undefined || compareName(leftName, rightName) <= 0) {
      merged.push(leftName)
      leftIndex += 1
      continue
    }
    merged.push(rightName)
    rightIndex += 1
  }
  return merged
}

interface NameWindow {
  /** At most `MAX_SYNC_LISTING_WINDOW` smallest names above the watermark, ascending. */
  readonly names: readonly string[]
  /** True when `names` covers every entry of the listing above the watermark. */
  readonly exhausted: boolean
}

/**
 * Collects the next ascending window of a directory listing in one streaming
 * pass: the `MAX_SYNC_LISTING_WINDOW` smallest names strictly above `watermark`
 * (or every remaining name when the listing has fewer). Retention is bounded by
 * the window, so a directory holding millions of children is never
 * materialized as a whole.
 */
async function nextNameWindow(directory: string, watermark: string | null): Promise<NameWindow> {
  const directoryHandle = await opendir(directory)
  let pending: string[] = []
  let selected: string[] = []
  let seen = 0
  try {
    for await (const child of directoryHandle) {
      if (watermark !== null && compareName(child.name, watermark) <= 0) continue
      seen += 1
      pending.push(child.name)
      if (pending.length === MAX_SYNC_LISTING_WINDOW) {
        selected = boundedMerge(selected, pending.sort(compareName))
        pending = []
      }
    }
  } finally {
    // Exhausting the async iterator closes the handle; a defensive close on
    // the already-closed handle must not mask the scan result.
    await directoryHandle.close().catch(() => undefined)
  }
  if (pending.length > 0) selected = boundedMerge(selected, pending.sort(compareName))
  // Selecting fewer names than the window proves nothing else is left above
  // the watermark; an exactly sized window counts as complete as well.
  return { names: selected, exhausted: seen <= MAX_SYNC_LISTING_WINDOW }
}

/**
 * Yields one directory's child names in ascending UTF-8 byte order.
 *
 * `opendir` streams entries in filesystem enumeration order, and the manifest
 * caps are applied while the tree is walked, so admission decisions would
 * otherwise depend on that order - and therefore on the host filesystem and
 * platform - instead of on the tree's contents. Each pass collects the next
 * window of names, so a listing with `children` entries costs
 * `ceil(children / MAX_SYNC_LISTING_WINDOW)` streaming passes and never retains
 * more than one window of names.
 */
async function* listChildrenInOrder(directory: string): AsyncGenerator<string> {
  let watermark: string | null = null
  for (;;) {
    const window = await nextNameWindow(directory, watermark)
    for (const name of window.names) yield name
    if (window.exhausted) return
    const last = window.names[window.names.length - 1]
    if (last === undefined) return
    watermark = last
  }
}

/**
 * Walks without following links, hashes through an opened file handle, and
 * bounds all transferable data before a transfer begins.
 *
 * Children are visited in ascending raw-name byte order and every subtree is
 * completed before the next sibling, so the caps below admit and block a
 * deterministic function of the tree's contents rather than of the order the
 * filesystem happened to enumerate.
 */
export async function scanSourceManifest(
  sourceRoot: string,
  options: ScanManifestOptions = {},
): Promise<SourceManifest> {
  if (!isAbsolute(sourceRoot)) throw new SourceRootError()
  const rootStat = await lstat(sourceRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new SourceRootError()
  const canonicalRoot = await realpath(sourceRoot)
  const maxBytes = options.maxBytes ?? MAX_SYNC_BYTES
  const maxDirectories = options.maxDirectories ?? MAX_SYNC_DIRECTORIES
  const maxFileBytes = options.maxFileBytes ?? MAX_SYNC_FILE_BYTES
  const maxFiles = options.maxFiles ?? MAX_SYNC_FILES
  for (const [limit, ceiling] of [
    [maxBytes, MAX_SYNC_BYTES],
    [maxDirectories, MAX_SYNC_DIRECTORIES],
    [maxFileBytes, MAX_SYNC_FILE_BYTES],
    [maxFiles, MAX_SYNC_FILES],
  ] as const) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > ceiling)
      throw new RangeError('Manifest limits must be safe non-negative integers')
  }

  const entries: ManifestEntry[] = []
  const blocked: BlockedSourceEntry[] = []
  const rawPaths: string[] = []
  let directories = 0
  let totalBytes = 0
  let transferableFiles = 0
  let blockedOverflow = false

  /** Records a blocked entry while keeping the report list bounded. */
  function addBlocked(candidate: BlockedSourceEntry): void {
    if (blocked.length < MAX_SYNC_BLOCKED) blocked.push(candidate)
    else blockedOverflow = true
  }

  /**
   * Excluded files still produce manifest metadata, which must stay bounded;
   * transferables fit the same budget through the file and directory caps.
   */
  const entryBudget = maxFiles + maxDirectories

  async function visit(directory: string, rawSegments: readonly string[]): Promise<void> {
    const directoryRealPath = await realpath(directory)
    if (!insideRoot(canonicalRoot, directoryRealPath)) {
      addBlocked({ path: safeDisplayPath(rawSegments.join('/')), reason: 'filesystem-race' })
      return
    }
    // Children are visited in ascending raw-name byte order (see
    // `listChildrenInOrder`), which keeps cap admission a function of the
    // tree's contents instead of `opendir` enumeration order. Each listing is
    // streamed in bounded windows, so a directory with millions of children
    // still cannot materialize its whole listing in memory.
    for await (const childName of listChildrenInOrder(directory)) {
      const rawChildSegments = [...rawSegments, childName]
      const rawPath = rawChildSegments.join('/')
      const normalizedRawPath = rawChildSegments
        .map((segment) => segment.normalize('NFC'))
        .join('/')
      rawPaths.push(rawPath)
      let path: ManifestPath
      try {
        path = normalizeManifestPath(normalizedRawPath)
      } catch {
        addBlocked({ path: safeDisplayPath(rawPath), reason: 'special-file' })
        continue
      }
      const fullPath = resolve(directory, childName)
      const metadata = await lstat(fullPath)
      if (metadata.isSymbolicLink()) {
        addBlocked({ path, reason: 'symlink' })
        continue
      }
      const exclusionReason: ExclusionReason | null = exclusionForPath(
        path,
        options.ignoreRuleGroups ?? [],
      )
      const common = {
        path,
        mtimeHintNanoseconds: nanosecondMtimeHint(metadata.mtimeMs),
        mode: metadata.mode & 0o7777,
        linkTarget: null,
        exclusionReason,
      }
      if (metadata.isDirectory()) {
        if (directories >= maxDirectories) {
          addBlocked({ path, reason: 'entry-limit' })
          continue
        }
        directories += 1
        entries.push(
          ManifestEntrySchema.parse({ ...common, type: 'directory', size: 0, sha256: null }),
        )
        if (exclusionReason === null) await visit(fullPath, rawChildSegments)
        continue
      }
      if (!metadata.isFile()) {
        addBlocked({ path, reason: 'special-file' })
        continue
      }
      if (exclusionReason !== null) {
        if (entries.length >= entryBudget) {
          addBlocked({ path, reason: 'entry-limit' })
          continue
        }
        entries.push(
          ManifestEntrySchema.parse({
            ...common,
            type: 'file',
            size: metadata.size,
            sha256: null,
          }),
        )
        continue
      }
      if (metadata.size > maxFileBytes || totalBytes + metadata.size > maxBytes) {
        addBlocked({ path, reason: 'size-limit' })
        continue
      }
      if (transferableFiles >= maxFiles) {
        addBlocked({ path, reason: 'file-limit' })
        continue
      }
      // The directory was realpath-checked at visit entry; re-verify the file
      // itself so a hostile directory swap between awaits cannot point the
      // open/read outside the canonical root.
      const fileRealPath = await realpath(fullPath)
      if (!insideRoot(canonicalRoot, fileRealPath)) {
        addBlocked({ path, reason: 'filesystem-race' })
        continue
      }
      const sha256 = await hashStableFile(fullPath, metadata)
      if (sha256 === null) {
        addBlocked({ path, reason: 'filesystem-race' })
        continue
      }
      totalBytes += metadata.size
      transferableFiles += 1
      entries.push(
        ManifestEntrySchema.parse({ ...common, type: 'file', size: metadata.size, sha256 }),
      )
    }
  }

  await visit(sourceRoot, [])
  entries.sort(comparePath)
  blocked.sort(comparePath)
  const collisions = findPathCollisions(rawPaths)
  const lines = entries.map((entry) => JSON.stringify(entry))
  const canonicalJsonl = Buffer.from(lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8')
  return {
    schemaVersion: 1,
    entries,
    canonicalJsonl,
    manifestSha256: createHash('sha256').update(canonicalJsonl).digest('hex'),
    totalBytes,
    transferableFiles,
    blocked,
    blockedOverflow,
    collisions,
  }
}

export function assertManifestTransferable(manifest: SourceManifest): void {
  if (manifest.blocked.length > 0 || manifest.collisions.length > 0) {
    throw new SourceManifestBlockedError(manifest.blocked.length, manifest.collisions.length)
  }
}

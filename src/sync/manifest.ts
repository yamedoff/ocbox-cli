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
 * Walks without following links, hashes through an opened file handle, and
 * bounds all transferable data before a transfer begins.
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
    // `opendir` streams one entry at a time, so a directory with millions of
    // children cannot materialize its whole listing in memory.
    const directoryHandle = await opendir(directory)
    try {
      for await (const child of directoryHandle) {
        const rawChildSegments = [...rawSegments, child.name]
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
        const fullPath = resolve(directory, child.name)
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
    } finally {
      // Exhausting the async iterator closes the handle; a defensive close on
      // the already-closed handle must not mask the scan result.
      await directoryHandle.close().catch(() => undefined)
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

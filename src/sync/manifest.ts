import { createHash } from 'node:crypto'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
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
  readonly reason: 'file-limit' | 'filesystem-race' | 'size-limit' | 'special-file' | 'symlink'
}

export interface SourceManifest {
  readonly schemaVersion: 1
  readonly entries: readonly ManifestEntry[]
  readonly canonicalJsonl: Uint8Array
  readonly manifestSha256: string
  readonly totalBytes: number
  readonly transferableFiles: number
  readonly blocked: readonly BlockedSourceEntry[]
  readonly collisions: readonly PathCollision[]
}

export interface ScanManifestOptions {
  readonly ignoreRuleGroups?: readonly (readonly IgnoreRule[])[]
  readonly maxBytes?: number
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
  const maxFileBytes = options.maxFileBytes ?? MAX_SYNC_FILE_BYTES
  const maxFiles = options.maxFiles ?? MAX_SYNC_FILES
  for (const limit of [maxBytes, maxFileBytes, maxFiles]) {
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new RangeError('Manifest limits must be safe non-negative integers')
  }

  const entries: ManifestEntry[] = []
  const blocked: BlockedSourceEntry[] = []
  const rawPaths: string[] = []
  let totalBytes = 0
  let transferableFiles = 0

  async function visit(directory: string, rawSegments: readonly string[]): Promise<void> {
    const directoryRealPath = await realpath(directory)
    if (!insideRoot(canonicalRoot, directoryRealPath)) {
      blocked.push({ path: safeDisplayPath(rawSegments.join('/')), reason: 'filesystem-race' })
      return
    }
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
    for (const child of children) {
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
        blocked.push({ path: safeDisplayPath(rawPath), reason: 'special-file' })
        continue
      }
      const fullPath = resolve(directory, child.name)
      const metadata = await lstat(fullPath)
      if (metadata.isSymbolicLink()) {
        blocked.push({ path, reason: 'symlink' })
        continue
      }
      const exclusionReason: ExclusionReason | null = exclusionForPath(
        path,
        options.ignoreRuleGroups ?? [],
      )
      const common = {
        path,
        mtimeHintNanoseconds: BigInt(Math.trunc(metadata.mtimeMs * 1_000_000)).toString(),
        mode: metadata.mode & 0o7777,
        linkTarget: null,
        exclusionReason,
      }
      if (metadata.isDirectory()) {
        entries.push(
          ManifestEntrySchema.parse({ ...common, type: 'directory', size: 0, sha256: null }),
        )
        if (exclusionReason === null) await visit(fullPath, rawChildSegments)
        continue
      }
      if (!metadata.isFile()) {
        blocked.push({ path, reason: 'special-file' })
        continue
      }
      if (exclusionReason !== null) {
        entries.push(
          ManifestEntrySchema.parse({ ...common, type: 'file', size: metadata.size, sha256: null }),
        )
        continue
      }
      if (metadata.size > maxFileBytes || totalBytes + metadata.size > maxBytes) {
        blocked.push({ path, reason: 'size-limit' })
        continue
      }
      if (transferableFiles >= maxFiles) {
        blocked.push({ path, reason: 'file-limit' })
        continue
      }
      const sha256 = await hashStableFile(fullPath, metadata)
      if (sha256 === null) {
        blocked.push({ path, reason: 'filesystem-race' })
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
    collisions,
  }
}

export function assertManifestTransferable(manifest: SourceManifest): void {
  if (manifest.blocked.length > 0 || manifest.collisions.length > 0) {
    throw new SourceManifestBlockedError(manifest.blocked.length, manifest.collisions.length)
  }
}

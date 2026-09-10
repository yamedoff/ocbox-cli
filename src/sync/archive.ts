import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  canonicalSnapshotJsonl,
  type SyncSnapshotEntry,
  SyncSnapshotEntrySchema,
  snapshotSha256,
} from './baseline.js'
import {
  MAX_SYNC_BYTES,
  MAX_SYNC_DIRECTORIES,
  MAX_SYNC_ENTRIES,
  MAX_SYNC_FILE_BYTES,
  MAX_SYNC_FILES,
} from './manifest.js'
import type { ManifestPath } from './path-policy.js'

const ARCHIVE_MAGIC = Buffer.from('OCBOXA1\n', 'ascii')
export const MAX_ARCHIVE_HEADER_BYTES = 65_536

const ArchiveEntryHeaderSchema = z.strictObject({
  type: z.literal('entry'),
  entry: SyncSnapshotEntrySchema,
})
const ArchiveEndHeaderSchema = z.strictObject({
  type: z.literal('end'),
  snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/),
})
const ArchiveHeaderSchema = z.discriminatedUnion('type', [
  ArchiveEntryHeaderSchema,
  ArchiveEndHeaderSchema,
])

export type SyncArchiveErrorCode =
  | 'ARCHIVE_FORMAT'
  | 'ARCHIVE_INTEGRITY'
  | 'ARCHIVE_LIMIT'
  | 'SOURCE_READ'

/** Safe archive failure that never echoes a source path or content. */
export class SyncArchiveError extends Error {
  constructor(readonly code: SyncArchiveErrorCode) {
    super(`Sync archive failed: ${code}`)
    this.name = 'SyncArchiveError'
  }
}

export interface SyncArchiveProgress {
  readonly phase: 'decode' | 'encode'
  readonly completedBytes: number
  readonly completedFiles: number
  readonly currentPath: ManifestPath | null
}

export type DecodedSyncArchiveEvent =
  | { readonly type: 'entry'; readonly entry: SyncSnapshotEntry }
  | { readonly type: 'data'; readonly path: ManifestPath; readonly data: Uint8Array }
  | { readonly type: 'end'; readonly snapshotSha256: string }

export interface EncodeSyncArchiveOptions {
  readonly maxBytes?: number
  readonly maxFileBytes?: number
  readonly maxFiles?: number
  readonly onProgress?: (progress: SyncArchiveProgress) => void | Promise<void>
}

export interface DecodeSyncArchiveOptions extends EncodeSyncArchiveOptions {}

function comparePath(left: { path: string }, right: { path: string }): number {
  return Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'))
}

function limit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 0 || result > fallback) {
    throw new SyncArchiveError('ARCHIVE_LIMIT')
  }
  return result
}

function encodeHeader(value: unknown): Uint8Array {
  const parsed = ArchiveHeaderSchema.safeParse(value)
  if (!parsed.success) throw new SyncArchiveError('ARCHIVE_FORMAT')
  const body = Buffer.from(JSON.stringify(parsed.data), 'utf8')
  if (body.byteLength === 0 || body.byteLength > MAX_ARCHIVE_HEADER_BYTES) {
    throw new SyncArchiveError('ARCHIVE_LIMIT')
  }
  const frame = Buffer.allocUnsafe(4 + body.byteLength)
  frame.writeUInt32BE(body.byteLength, 0)
  body.copy(frame, 4)
  return frame
}

function parseHeader(body: Uint8Array): z.infer<typeof ArchiveHeaderSchema> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    const parsed = ArchiveHeaderSchema.safeParse(JSON.parse(text))
    if (!parsed.success) throw new SyncArchiveError('ARCHIVE_FORMAT')
    return parsed.data
  } catch (error) {
    if (error instanceof SyncArchiveError) throw error
    throw new SyncArchiveError('ARCHIVE_FORMAT')
  }
}

function validateArchiveEntries(
  input: readonly SyncSnapshotEntry[],
  options: EncodeSyncArchiveOptions,
): readonly SyncSnapshotEntry[] {
  const maxBytes = limit(options.maxBytes, MAX_SYNC_BYTES)
  const maxFileBytes = limit(options.maxFileBytes, MAX_SYNC_FILE_BYTES)
  const maxFiles = limit(options.maxFiles, MAX_SYNC_FILES)
  let entries: SyncSnapshotEntry[]
  try {
    entries = input.map((entry) => SyncSnapshotEntrySchema.parse(entry)).toSorted(comparePath)
    // This also enforces unique paths using the same canonical representation as the baseline.
    canonicalSnapshotJsonl(entries)
  } catch {
    throw new SyncArchiveError('ARCHIVE_FORMAT')
  }
  let bytes = 0
  let directories = 0
  let files = 0
  for (const entry of entries) {
    if (entry.type === 'directory') {
      directories += 1
      if (directories > MAX_SYNC_DIRECTORIES) throw new SyncArchiveError('ARCHIVE_LIMIT')
      continue
    }
    files += 1
    bytes += entry.size
    if (entry.size > maxFileBytes || files > maxFiles || bytes > maxBytes) {
      throw new SyncArchiveError('ARCHIVE_LIMIT')
    }
  }
  return entries
}

/**
 * Encodes a deterministic archive while yielding file chunks immediately.
 * The encoder verifies each source stream against the manifest before ending.
 */
export async function* encodeSyncArchive(
  input: readonly SyncSnapshotEntry[],
  openFile: (path: ManifestPath) => AsyncIterable<Uint8Array>,
  options: EncodeSyncArchiveOptions = {},
): AsyncIterable<Uint8Array> {
  const entries = validateArchiveEntries(input, options)
  yield ARCHIVE_MAGIC
  let completedBytes = 0
  let completedFiles = 0
  for (const entry of entries) {
    yield encodeHeader({ type: 'entry', entry })
    if (entry.type !== 'file') continue
    const hash = createHash('sha256')
    let size = 0
    try {
      for await (const sourceChunk of openFile(entry.path)) {
        const chunk = new Uint8Array(sourceChunk)
        size += chunk.byteLength
        if (size > entry.size) throw new SyncArchiveError('ARCHIVE_INTEGRITY')
        hash.update(chunk)
        completedBytes += chunk.byteLength
        yield chunk
        await options.onProgress?.({
          phase: 'encode',
          completedBytes,
          completedFiles,
          currentPath: entry.path,
        })
      }
    } catch (error) {
      if (error instanceof SyncArchiveError) throw error
      throw new SyncArchiveError('SOURCE_READ')
    }
    if (size !== entry.size || hash.digest('hex') !== entry.sha256) {
      throw new SyncArchiveError('ARCHIVE_INTEGRITY')
    }
    completedFiles += 1
    await options.onProgress?.({
      phase: 'encode',
      completedBytes,
      completedFiles,
      currentPath: entry.path,
    })
  }
  const digest = snapshotSha256(entries)
  yield encodeHeader({ type: 'end', snapshotSha256: digest })
  await options.onProgress?.({
    phase: 'encode',
    completedBytes,
    completedFiles,
    currentPath: null,
  })
}

/**
 * Decodes arbitrary chunk boundaries while retaining at most one bounded
 * header and forwarding file data as soon as it arrives.
 */
export async function* decodeSyncArchive(
  chunks: AsyncIterable<Uint8Array>,
  options: DecodeSyncArchiveOptions = {},
): AsyncIterable<DecodedSyncArchiveEvent> {
  const maxBytes = limit(options.maxBytes, MAX_SYNC_BYTES)
  const maxFileBytes = limit(options.maxFileBytes, MAX_SYNC_FILE_BYTES)
  const maxFiles = limit(options.maxFiles, MAX_SYNC_FILES)
  let state: 'data' | 'ended' | 'header' | 'length' | 'magic' = 'magic'
  let magicOffset = 0
  const lengthBuffer = Buffer.alloc(4)
  let lengthOffset = 0
  let headerBuffer: Buffer | undefined
  let headerOffset = 0
  let currentEntry: SyncSnapshotEntry | undefined
  let remainingFileBytes = 0
  let currentHash: ReturnType<typeof createHash> | undefined
  const entries: SyncSnapshotEntry[] = []
  let previousPath: string | undefined
  let completedBytes = 0
  let completedFiles = 0
  let declaredBytes = 0

  const finishFile = async (): Promise<void> => {
    if (currentEntry === undefined || currentHash === undefined || remainingFileBytes !== 0) {
      throw new SyncArchiveError('ARCHIVE_FORMAT')
    }
    if (currentHash.digest('hex') !== currentEntry.sha256) {
      throw new SyncArchiveError('ARCHIVE_INTEGRITY')
    }
    completedFiles += 1
    await options.onProgress?.({
      phase: 'decode',
      completedBytes,
      completedFiles,
      currentPath: currentEntry.path,
    })
    currentEntry = undefined
    currentHash = undefined
    state = 'length'
  }

  for await (const sourceChunk of chunks) {
    const chunk = new Uint8Array(sourceChunk)
    let offset = 0
    while (offset < chunk.byteLength) {
      if (state === 'ended') throw new SyncArchiveError('ARCHIVE_FORMAT')
      if (state === 'magic') {
        const count = Math.min(ARCHIVE_MAGIC.byteLength - magicOffset, chunk.byteLength - offset)
        for (let index = 0; index < count; index += 1) {
          if (chunk[offset + index] !== ARCHIVE_MAGIC[magicOffset + index]) {
            throw new SyncArchiveError('ARCHIVE_FORMAT')
          }
        }
        magicOffset += count
        offset += count
        if (magicOffset === ARCHIVE_MAGIC.byteLength) state = 'length'
        continue
      }
      if (state === 'length') {
        const count = Math.min(4 - lengthOffset, chunk.byteLength - offset)
        lengthBuffer.set(chunk.subarray(offset, offset + count), lengthOffset)
        lengthOffset += count
        offset += count
        if (lengthOffset === 4) {
          const length = lengthBuffer.readUInt32BE(0)
          if (length === 0 || length > MAX_ARCHIVE_HEADER_BYTES) {
            throw new SyncArchiveError('ARCHIVE_LIMIT')
          }
          headerBuffer = Buffer.allocUnsafe(length)
          headerOffset = 0
          lengthOffset = 0
          state = 'header'
        }
        continue
      }
      if (state === 'header') {
        if (headerBuffer === undefined) throw new SyncArchiveError('ARCHIVE_FORMAT')
        const count = Math.min(headerBuffer.byteLength - headerOffset, chunk.byteLength - offset)
        headerBuffer.set(chunk.subarray(offset, offset + count), headerOffset)
        headerOffset += count
        offset += count
        if (headerOffset < headerBuffer.byteLength) continue
        const header = parseHeader(headerBuffer)
        headerBuffer = undefined
        headerOffset = 0
        if (header.type === 'end') {
          if (header.snapshotSha256 !== snapshotSha256(entries)) {
            throw new SyncArchiveError('ARCHIVE_INTEGRITY')
          }
          state = 'ended'
          yield { type: 'end', snapshotSha256: header.snapshotSha256 }
          await options.onProgress?.({
            phase: 'decode',
            completedBytes,
            completedFiles,
            currentPath: null,
          })
          continue
        }
        const entry = header.entry
        if (previousPath !== undefined && comparePath({ path: previousPath }, entry) >= 0) {
          throw new SyncArchiveError('ARCHIVE_FORMAT')
        }
        previousPath = entry.path
        entries.push(entry)
        if (entries.length > MAX_SYNC_ENTRIES) throw new SyncArchiveError('ARCHIVE_LIMIT')
        yield { type: 'entry', entry }
        if (entry.type === 'directory') {
          state = 'length'
          continue
        }
        if (entry.size > maxFileBytes || completedFiles >= maxFiles) {
          throw new SyncArchiveError('ARCHIVE_LIMIT')
        }
        declaredBytes += entry.size
        if (declaredBytes > maxBytes) throw new SyncArchiveError('ARCHIVE_LIMIT')
        remainingFileBytes = entry.size
        currentEntry = entry
        currentHash = createHash('sha256')
        state = 'data'
        if (remainingFileBytes === 0) await finishFile()
        continue
      }
      if (state === 'data') {
        if (currentEntry === undefined || currentHash === undefined) {
          throw new SyncArchiveError('ARCHIVE_FORMAT')
        }
        const count = Math.min(remainingFileBytes, chunk.byteLength - offset)
        const data = chunk.subarray(offset, offset + count)
        remainingFileBytes -= count
        completedBytes += count
        if (completedBytes > maxBytes) throw new SyncArchiveError('ARCHIVE_LIMIT')
        currentHash.update(data)
        offset += count
        if (count > 0) {
          yield { type: 'data', path: currentEntry.path, data }
          await options.onProgress?.({
            phase: 'decode',
            completedBytes,
            completedFiles,
            currentPath: currentEntry.path,
          })
        }
        if (remainingFileBytes === 0) await finishFile()
      }
    }
  }
  if (state !== 'ended') throw new SyncArchiveError('ARCHIVE_FORMAT')
}

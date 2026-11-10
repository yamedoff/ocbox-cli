import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { OcboxError, type OcboxErrorCode } from '../errors/index.js'
import { newRequestId } from '../auth/errors.js'
import { sha256Hex } from '../providers/ocbox/source.js'
import {
  CAS_LIMITS,
  casHash,
  CasManifestSchema,
  CasPageSchema,
  validateCasPages,
  type CasBlob,
  type CasFile,
  type CasManifest,
  type CasPage,
} from './cas-contract.js'
import type { SourceManifest } from './manifest.js'

export interface CasSnapshot {
  createdAt: number
  manifest: CasManifest
  pages: CasPage[]
}
const SnapshotSchema = z.strictObject({
  createdAt: z.number().int().nonnegative().safe(),
  manifest: CasManifestSchema,
  pages: z.array(CasPageSchema).max(CAS_LIMITS.maxPages),
})
export function casError(code: OcboxErrorCode, message: string): OcboxError {
  return new OcboxError({ code, message, requestId: newRequestId() })
}

/** Metadata never contains source bytes, absolute paths or upload capabilities. */
export async function readCasState(path: string): Promise<CasSnapshot | undefined> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.size > CAS_LIMITS.maxManifestBytes + 1024 * 1024)
      throw new Error()
    const result = SnapshotSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    validateCasPages(result.manifest, result.pages)
    return result
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw casError(
      'SYNC_INTEGRITY',
      'Local sync state is invalid; remove the workspace CAS state and retry',
    )
  }
}
export async function writeCasState(path: string, snapshot: CasSnapshot): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
export async function prepareCasDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (!(await lstat(directory)).isDirectory())
    throw casError('SYNC_INTEGRITY', 'Local sync cache is unsafe')
}

/** Recheck cached bytes; unsigned state alone never proves blob integrity. */
export async function readCasBlob(cache: string, blob: CasBlob): Promise<Buffer> {
  const handle = await open(join(cache, blob.hash), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size !== blob.size || blob.size > CAS_LIMITS.partBytes)
      throw new Error()
    const bytes = await handle.readFile()
    if (bytes.length !== blob.size || sha256Hex(bytes) !== blob.hash) throw new Error()
    return bytes
  } finally {
    await handle.close()
  }
}

/** Deterministic 8 MiB bundles, 16 MiB large-file parts, and standalone small edits. */
async function packCasFiles(
  root: string,
  cache: string,
  files: CasFile[],
  previous?: CasSnapshot,
): Promise<CasBlob[]> {
  const oldFiles = new Map(previous?.pages.flatMap((p) => p.files).map((f) => [f.path, f]))
  const oldBlobs = new Map(previous?.pages.flatMap((p) => p.blobs).map((b) => [b.hash, b]))
  const verified = new Map<string, boolean>(),
    blobs = new Map<string, CasBlob>()
  const dirty: Extract<CasFile, { type: 'file' }>[] = []
  for (const file of files) {
    if (file.type !== 'file') continue
    const old = oldFiles.get(file.path)
    let reusable = old?.type === 'file' && old.hash === file.hash && old.size === file.size
    if (reusable && old?.type === 'file') {
      for (const part of old.parts) {
        const blob = oldBlobs.get(part.hash)
        if (blob && !verified.has(blob.hash)) {
          verified.set(
            blob.hash,
            await readCasBlob(cache, blob).then(
              () => true,
              () => false,
            ),
          )
        }
        if (!blob || !verified.get(part.hash)) reusable = false
      }
    }
    if (reusable && old?.type === 'file') {
      file.parts = structuredClone(old.parts)
      for (const part of old.parts) {
        const blob = oldBlobs.get(part.hash)
        if (blob) blobs.set(blob.hash, blob)
      }
    } else dirty.push(file)
  }
  const save = async (bytes: Buffer): Promise<CasBlob> => {
    const blob = { hash: sha256Hex(bytes), size: bytes.length }
    const temporary = join(cache, `${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
      await rename(temporary, join(cache, blob.hash))
    } finally {
      await rm(temporary, { force: true })
    }
    blobs.set(blob.hash, blob)
    return blob
  }
  let bundle: { file: Extract<CasFile, { type: 'file' }>; bytes: Buffer }[] = [],
    bundleBytes = 0
  const flush = async () => {
    if (!bundle.length) return
    const blob = await save(
      Buffer.concat(
        bundle.map((p) => p.bytes),
        bundleBytes,
      ),
    )
    let offset = 0
    for (const { file, bytes } of bundle) {
      file.parts = [{ hash: blob.hash, offset, size: bytes.length }]
      offset += bytes.length
    }
    bundle = []
    bundleBytes = 0
  }
  const canonicalRoot = await realpath(root)
  for (const file of dirty) {
    if (!file.size) continue
    const absolute = join(root, file.path)
    const rel = relative(canonicalRoot, await realpath(absolute))
    if (
      isAbsolute(rel) ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      resolve(canonicalRoot, rel) === canonicalRoot
    )
      throw new Error()
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    const digest = createHash('sha256')
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size !== file.size) throw new Error()
      const small = file.size <= CAS_LIMITS.bundleBytes
      let read = 0
      while (read < file.size) {
        const bytes = Buffer.alloc(
          Math.min(small ? CAS_LIMITS.bundleBytes : CAS_LIMITS.partBytes, file.size - read),
        )
        let offset = 0
        while (offset < bytes.length) {
          const part = await handle.read(bytes, offset, bytes.length - offset)
          if (!part.bytesRead) throw new Error()
          offset += part.bytesRead
        }
        read += bytes.length
        digest.update(bytes)
        if (small && !(previous && dirty.length <= CAS_LIMITS.pageEntries)) {
          if (bundleBytes + bytes.length > CAS_LIMITS.bundleBytes) await flush()
          bundle.push({ file, bytes })
          bundleBytes += bytes.length
        } else {
          await flush()
          const blob = await save(bytes)
          file.parts.push({ hash: blob.hash, offset: 0, size: bytes.length })
        }
      }
      const after = await handle.stat()
      if (
        digest.digest('hex') !== file.hash ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error()
    } finally {
      await handle.close()
    }
  }
  await flush()
  return [...blobs.values()]
}

/** Build bounded pages using the CLI's already checked and hashed source tree. */
export async function buildCasSnapshot(
  root: string,
  cache: string,
  source: SourceManifest,
  previous?: CasSnapshot,
): Promise<CasSnapshot> {
  const files: CasFile[] = source.entries
    .filter((e) => e.exclusionReason === null)
    .map((e) =>
      e.type === 'directory'
        ? { path: e.path, type: 'directory' }
        : {
            path: e.path,
            type: 'file',
            hash: e.sha256 as string,
            size: e.size,
            mode: e.mode & 0o111 ? 493 : 420,
            parts: [],
          },
    )
  let blobs: CasBlob[]
  try {
    blobs = await packCasFiles(root, cache, files, previous)
  } catch (error) {
    if (error instanceof OcboxError) throw error
    throw casError(
      'SYNC_INTEGRITY',
      'Source or cached content changed during sync; retry with a stable tree',
    )
  }
  if (blobs.length > CAS_LIMITS.maxBlobs || files.length > 100_000)
    throw casError('SYNC_TOO_LARGE', 'Source sync exceeds the file or blob count limit')
  const byHash = new Map(blobs.map((b) => [b.hash, b]))
  const makePage = (entries: CasFile[], index: number): CasPage => ({
    index,
    files: entries,
    blobs: [
      ...new Set(entries.flatMap((f) => (f.type === 'file' ? f.parts.map((p) => p.hash) : []))),
    ]
      .sort()
      .map((hash) => byHash.get(hash) as CasBlob),
  })
  const pages: CasPage[] = []
  let entries: CasFile[] = [],
    pageBytes = 64,
    pageBlobs = new Set<string>()
  for (const file of files) {
    const hashes = file.type === 'file' ? [...new Set(file.parts.map((p) => p.hash))] : []
    const size = () =>
      Buffer.byteLength(JSON.stringify(file)) +
      1 +
      hashes
        .filter((h) => !pageBlobs.has(h))
        .reduce((n, h) => n + Buffer.byteLength(JSON.stringify(byHash.get(h))) + 1, 0)
    if (
      entries.length &&
      (entries.length >= CAS_LIMITS.pageEntries || pageBytes + size() > CAS_LIMITS.maxPageBytes)
    ) {
      pages.push(makePage(entries, pages.length))
      entries = []
      pageBytes = 64
      pageBlobs = new Set()
    }
    pageBytes += size()
    hashes.forEach((h) => {
      pageBlobs.add(h)
    })
    entries.push(file)
  }
  if (entries.length || !pages.length) pages.push(makePage(entries, pages.length))
  const manifest = {
    syncId: randomUUID().replaceAll('-', ''),
    pageHashes: pages.map(({ files, blobs }) => casHash({ files, blobs })),
    fileCount: files.length,
    totalBytes: source.totalBytes,
  }
  try {
    validateCasPages(manifest, pages)
  } catch {
    throw casError('SYNC_TOO_LARGE', 'Source sync metadata exceeds the supported limits')
  }
  return { createdAt: Date.now(), manifest, pages }
}

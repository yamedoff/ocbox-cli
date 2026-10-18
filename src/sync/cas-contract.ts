import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ManifestPathSchema } from './path-policy.js'

export const CAS_LIMITS = {
  bundleBytes: 8 * 1024 * 1024,
  partBytes: 16 * 1024 * 1024,
  pageEntries: 512,
  maxPageBytes: 512 * 1024,
  maxPages: 512,
  maxBlobs: 4096,
  maxManifestBytes: 32 * 1024 * 1024,
  uploadConcurrency: 4,
  attempts: 3,
  uploadTimeoutMs: 120_000,
  applyTimeoutMs: 900_000,
  retryMs: 1000,
} as const

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const size = z.number().int().nonnegative().safe()
export const CasBlobSchema = z.strictObject({ hash, size: size.max(CAS_LIMITS.partBytes) })
const part = z.strictObject({ hash, offset: size, size })
const path = ManifestPathSchema.refine((value) =>
  value.split('/').every((segment) => segment !== '.ocb-cas-owned.json'),
)
export const CasFileSchema = z.discriminatedUnion('type', [
  z.strictObject({ path, type: z.literal('directory') }),
  z.strictObject({
    path,
    type: z.literal('file'),
    hash,
    size: size.max(268_435_456),
    mode: z.union([z.literal(420), z.literal(493)]),
    parts: z.array(part).max(65),
  }),
])
export const CasPageSchema = z.strictObject({
  index: size.max(CAS_LIMITS.maxPages - 1),
  files: z.array(CasFileSchema).max(CAS_LIMITS.pageEntries),
  blobs: z.array(CasBlobSchema).max(CAS_LIMITS.maxBlobs),
})
export const CasManifestSchema = z.strictObject({
  syncId: z.string().regex(/^[a-f0-9]{32}$/),
  pageHashes: z.array(hash).min(1).max(CAS_LIMITS.maxPages),
  fileCount: size.max(100_000),
  totalBytes: size.max(1_073_741_824),
})
export const CasResultSchema = z.strictObject({
  version: z.literal(2),
  planId: z.string().regex(/^casdo_[a-f0-9]{30}$/),
  state: z.enum(['uploading', 'pending', 'succeeded', 'failed']),
  expiresAt: size,
  replayed: z.boolean(),
  missing: z
    .array(CasBlobSchema.extend({ url: z.string().max(16_384) }))
    .max(CAS_LIMITS.maxBlobs)
    .optional(),
  fetchedBlobs: size.optional(),
  fetchedBytes: size.optional(),
  reason: z.string().max(128).optional(),
})
export type CasFile = z.infer<typeof CasFileSchema>
export type CasBlob = z.infer<typeof CasBlobSchema>
export type CasPage = z.infer<typeof CasPageSchema>
export type CasManifest = z.infer<typeof CasManifestSchema>
export type CasResult = z.infer<typeof CasResultSchema>
export type CasRequest =
  | { operation: 'plan'; manifest: CasManifest; page: CasPage; idempotencyKey: string }
  | { operation: 'apply'; planId: string; idempotencyKey: string }
export interface CasTransport {
  readonly sessionId: string
  readonly scope: string
  call(request: CasRequest): Promise<CasResult>
}

/** Canonical object-key ordering is part of the v2 page identity. */
export function casHash(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, child]) => [key, canonical(child)]),
          )
        : v
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}

/** Validates persisted unsigned metadata before it can select cache files. */
export function validateCasPages(manifest: CasManifest, pages: CasPage[]): void {
  CasManifestSchema.parse(manifest)
  if (pages.length !== manifest.pageHashes.length) throw new Error('Invalid pages')
  const paths = new Set<string>(),
    blobs = new Map<string, number>()
  let count = 0,
    bytes = 0,
    metadata = 0
  for (const [index, page] of pages.entries()) {
    CasPageSchema.parse(page)
    metadata += Buffer.byteLength(JSON.stringify(page))
    if (
      page.index !== index ||
      Buffer.byteLength(JSON.stringify(page)) > CAS_LIMITS.maxPageBytes ||
      casHash({ files: page.files, blobs: page.blobs }) !== manifest.pageHashes[index]
    )
      throw new Error('Invalid page')
    const localBlobs = new Map(page.blobs.map((blob) => [blob.hash, blob.size]))
    if (localBlobs.size !== page.blobs.length) throw new Error('Duplicate blob')
    for (const blob of page.blobs) {
      if (blobs.has(blob.hash) && blobs.get(blob.hash) !== blob.size)
        throw new Error('Invalid blob')
      blobs.set(blob.hash, blob.size)
    }
    for (const file of page.files) {
      if (paths.has(file.path)) throw new Error('Duplicate path')
      paths.add(file.path)
      count++
      if (file.type === 'directory') continue
      bytes += file.size
      let partBytes = 0
      for (const part of file.parts) {
        const bound = localBlobs.get(part.hash)
        if (bound === undefined || part.offset + part.size > bound) throw new Error('Invalid part')
        partBytes += part.size
      }
      if (partBytes !== file.size) throw new Error('Invalid file')
    }
  }
  if (
    count !== manifest.fileCount ||
    bytes !== manifest.totalBytes ||
    blobs.size > CAS_LIMITS.maxBlobs ||
    metadata > CAS_LIMITS.maxManifestBytes
  )
    throw new Error('Invalid manifest')
}

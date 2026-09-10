import { createHash } from 'node:crypto'
import { z } from 'zod'
import { type UtcTimestamp, UtcTimestampSchema } from '../domain/timestamps.js'
import { MAX_SYNC_ENTRIES, ManifestEntrySchema, type SourceManifest } from './manifest.js'
import { ManifestPathSchema } from './path-policy.js'

const SHA256 = /^[0-9a-f]{64}$/

export const SyncSnapshotEntrySchema = z
  .strictObject({
    path: ManifestPathSchema,
    type: z.enum(['directory', 'file']),
    size: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(SHA256).nullable(),
    mode: z.number().int().min(0).max(0o7777),
    linkTarget: ManifestPathSchema.nullable(),
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
        message: 'Directory snapshots require zero size and no checksum',
      })
    }
    if (entry.type === 'file' && entry.sha256 === null) {
      context.addIssue({ code: 'custom', path: ['sha256'], message: 'Files require a checksum' })
    }
  })

export type SyncSnapshotEntry = z.infer<typeof SyncSnapshotEntrySchema>

function comparePath(left: { path: string }, right: { path: string }): number {
  return Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'))
}

/** Serializes a portable snapshot with bytewise path order and a trailing newline. */
export function canonicalSnapshotJsonl(entries: readonly SyncSnapshotEntry[]): Uint8Array {
  const parsed = entries.map((entry) => SyncSnapshotEntrySchema.parse(entry)).toSorted(comparePath)
  const paths = new Set<string>()
  for (const entry of parsed) {
    if (paths.has(entry.path)) throw new TypeError('A sync snapshot cannot contain duplicate paths')
    paths.add(entry.path)
  }
  return Buffer.from(
    parsed.length === 0 ? '' : `${parsed.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  )
}

/** Produces content identity entries, omitting mtime hints and excluded names. */
export function snapshotEntries(manifest: SourceManifest): readonly SyncSnapshotEntry[] {
  return manifest.entries
    .filter((entry) => entry.exclusionReason === null)
    .map((entry) =>
      SyncSnapshotEntrySchema.parse({
        path: entry.path,
        type: entry.type,
        size: entry.size,
        sha256: entry.sha256,
        mode: entry.mode,
        linkTarget: entry.linkTarget,
      }),
    )
    .toSorted(comparePath)
}

/** Hashes the exact canonical content used for three-way comparisons. */
export function snapshotSha256(entries: readonly SyncSnapshotEntry[]): string {
  return createHash('sha256').update(canonicalSnapshotJsonl(entries)).digest('hex')
}

const VerifiedSyncBaselineCoreSchema = z.strictObject({
  schemaVersion: z.literal(1),
  verified: z.literal(true),
  verifiedAt: UtcTimestampSchema,
  snapshotSha256: z.string().regex(SHA256),
  entries: z.array(SyncSnapshotEntrySchema).max(MAX_SYNC_ENTRIES).readonly(),
})

export const VerifiedSyncBaselineSchema = VerifiedSyncBaselineCoreSchema.superRefine(
  (baseline, context) => {
    let canonical: Uint8Array
    try {
      canonical = canonicalSnapshotJsonl(baseline.entries)
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['entries'],
        message: error instanceof Error ? error.message : 'Invalid baseline entries',
      })
      return
    }
    const expected = createHash('sha256').update(canonical).digest('hex')
    if (expected !== baseline.snapshotSha256) {
      context.addIssue({
        code: 'custom',
        path: ['snapshotSha256'],
        message: 'Baseline checksum does not match its canonical entries',
      })
    }
    const sorted = [...baseline.entries].sort(comparePath)
    if (sorted.some((entry, index) => entry.path !== baseline.entries[index]?.path)) {
      context.addIssue({
        code: 'custom',
        path: ['entries'],
        message: 'Baseline is not bytewise sorted',
      })
    }
  },
)

export const UnverifiedSyncBaselineSchema = z.strictObject({
  schemaVersion: z.literal(1),
  verified: z.literal(false),
})

export const SyncBaselineEvidenceSchema = z.union([
  VerifiedSyncBaselineSchema,
  UnverifiedSyncBaselineSchema,
])

export type VerifiedSyncBaseline = z.infer<typeof VerifiedSyncBaselineSchema>
export type SyncBaselineEvidence = z.infer<typeof SyncBaselineEvidenceSchema>

/** Creates baseline evidence only after the caller has verified the completed apply. */
export function createVerifiedBaseline(
  manifest: SourceManifest,
  verifiedAt: UtcTimestamp,
): VerifiedSyncBaseline {
  if (manifest.blocked.length > 0 || manifest.collisions.length > 0) {
    throw new TypeError('Cannot baseline a blocked source manifest')
  }
  const entries = snapshotEntries(manifest)
  return VerifiedSyncBaselineSchema.parse({
    schemaVersion: 1,
    verified: true,
    verifiedAt,
    snapshotSha256: snapshotSha256(entries),
    entries,
  })
}

/** Parses persisted evidence and rejects tampered or non-canonical baselines. */
export function parseSyncBaseline(input: unknown): SyncBaselineEvidence {
  return SyncBaselineEvidenceSchema.parse(input)
}

/** Converts validated manifest entries received through a transfer boundary. */
export function snapshotFromManifestEntries(
  input: readonly unknown[],
): readonly SyncSnapshotEntry[] {
  return input
    .map((entry) => ManifestEntrySchema.parse(entry))
    .filter((entry) => entry.exclusionReason === null)
    .map((entry) =>
      SyncSnapshotEntrySchema.parse({
        path: entry.path,
        type: entry.type,
        size: entry.size,
        sha256: entry.sha256,
        mode: entry.mode,
        linkTarget: entry.linkTarget,
      }),
    )
    .toSorted(comparePath)
}

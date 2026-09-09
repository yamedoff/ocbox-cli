import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  canonicalSnapshotJsonl,
  type SyncSnapshotEntry,
  snapshotSha256,
} from '../../src/sync/baseline.js'
import { normalizeManifestPath } from '../../src/sync/path-policy.js'

function syntheticEntries(count: number): readonly SyncSnapshotEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    path: normalizeManifestPath(`tree/${String(index).padStart(6, '0')}.txt`),
    type: 'file' as const,
    size: 1,
    sha256: createHash('sha256').update(String(index)).digest('hex'),
    mode: 0o644,
    linkTarget: null,
  }))
}

/** Bounded CI proxy; `pnpm bench:sync` runs the 10k and 100k in-memory cases. */
describe('sync manifest benchmark harness', () => {
  it('canonicalizes a focused 1k entry sample without filesystem fixtures', () => {
    const entries = syntheticEntries(1_000)
    expect(snapshotSha256(entries)).toMatch(/^[0-9a-f]{64}$/)
    expect(canonicalSnapshotJsonl(entries).byteLength).toBeGreaterThan(1_000)
  })
})

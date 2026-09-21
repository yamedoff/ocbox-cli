import { createHash } from 'node:crypto'
import { bench, describe } from 'vitest'
import { type SyncSnapshotEntry, snapshotSha256 } from '../src/sync/baseline.js'
import { normalizeManifestPath } from '../src/sync/path-policy.js'

function entries(count: number): readonly SyncSnapshotEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    path: normalizeManifestPath(`tree/${String(index).padStart(6, '0')}.txt`),
    type: 'file' as const,
    size: 1,
    sha256: createHash('sha256').update(String(index)).digest('hex'),
    mode: 0o644,
    linkTarget: null,
  }))
}
describe('sync manifest canonicalization', () => {
  bench('10k entries (in memory)', () => {
    snapshotSha256(entries(10_000))
  })
  bench('100k entries (in memory)', () => {
    snapshotSha256(entries(100_000))
  })
})

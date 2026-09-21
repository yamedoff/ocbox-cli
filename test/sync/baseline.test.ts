import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UtcTimestampSchema } from '../../src/domain/timestamps.js'
import {
  createVerifiedBaseline,
  parseSyncBaseline,
  snapshotEntries,
} from '../../src/sync/baseline.js'
import { scanSourceManifest } from '../../src/sync/manifest.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

describe('verified sync baseline', () => {
  it('stores only transferable content identity and detects tampering', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ocbox-baseline-'))
    roots.push(directory)
    await writeFile(join(directory, 'source.txt'), 'portable')
    await writeFile(join(directory, '.env.local'), 'excluded')
    const manifest = await scanSourceManifest(directory)
    const baseline = createVerifiedBaseline(
      manifest,
      UtcTimestampSchema.parse('2026-09-10T00:00:00.000Z'),
    )

    expect(baseline.entries).toEqual(snapshotEntries(manifest))
    expect(baseline.entries.map((entry) => entry.path)).toEqual(['source.txt'])
    expect(JSON.stringify(baseline)).not.toContain(directory)
    expect(() => parseSyncBaseline({ ...baseline, snapshotSha256: '0'.repeat(64) })).toThrow()
  })

  it('preserves an explicit unverified marker without accepting payload data', () => {
    expect(parseSyncBaseline({ schemaVersion: 1, verified: false })).toEqual({
      schemaVersion: 1,
      verified: false,
    })
    expect(() => parseSyncBaseline({ schemaVersion: 1, verified: false, entries: [] })).toThrow()
  })
})

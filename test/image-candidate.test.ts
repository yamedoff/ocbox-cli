import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('T7 base image candidate', () => {
  it('passes the repository-owned static verifier', () => {
    const result = spawnSync(process.execPath, ['scripts/verify-image-candidate.mjs'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      shell: false,
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 1, verified: true, registry: false })
  })

  it('keeps release claims machine-blocked pending T8 and T9', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../images/ocbox-base/manifest.json', import.meta.url), 'utf8'),
    ) as { release: Record<string, unknown> }
    expect(manifest.release).toMatchObject({
      stable: false,
      providerPublicationVerified: false,
      fiveRunBenchmarksVerified: false,
      benchmarkRuns: 0,
    })
  })
})

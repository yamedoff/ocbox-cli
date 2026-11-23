import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const packScript = join(repoRoot, 'scripts', 'pack-release.mjs')
const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('pack:release', () => {
  it('packs ocbox-<version>.tgz and writes its hash to SHA256SUMS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocbox-pack-release-'))
    directories.push(root)
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'opencloudbox', version: '9.8.7' }),
    )
    await writeFile(join(root, 'README.md'), '# fixture\n')

    const result = spawnSync(process.execPath, [packScript], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    })

    expect(result.status).toBe(0)
    const releaseDir = join(root, 'dist', 'release')
    const tarball = join(releaseDir, 'ocbox-9.8.7.tgz')
    expect(existsSync(tarball)).toBe(true)
    expect(existsSync(join(releaseDir, 'opencloudbox-9.8.7.tgz'))).toBe(false)

    const hash = createHash('sha256')
      .update(await readFile(tarball))
      .digest('hex')
    const sums = await readFile(join(releaseDir, 'SHA256SUMS'), 'utf8')
    expect(sums).toBe(`${hash}  ocbox-9.8.7.tgz\n`)
    expect(await readFile(join(releaseDir, 'LATEST'), 'utf8')).toBe('9.8.7\n')
  })
})

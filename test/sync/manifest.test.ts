import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertManifestTransferable,
  SourceManifestBlockedError,
  scanSourceManifest,
} from '../../src/sync/manifest.js'

const roots: string[] = []
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ocbox-manifest-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

describe('source manifest', () => {
  it('hashes binary files and emits bytewise sorted canonical JSONL', async () => {
    const directory = await root()
    await mkdir(join(directory, 'src'))
    await writeFile(join(directory, 'z.bin'), Uint8Array.of(0, 255, 1, 128))
    await writeFile(join(directory, 'src', 'é.txt'), 'content')

    const manifest = await scanSourceManifest(directory)
    expect(manifest.blocked).toEqual([])
    expect(manifest.collisions).toEqual([])
    expect(manifest.entries.map((entry) => entry.path)).toEqual(['src', 'src/é.txt', 'z.bin'])
    expect(manifest.entries.at(-1)).toMatchObject({
      size: 4,
      sha256: createHash('sha256')
        .update(Uint8Array.of(0, 255, 1, 128))
        .digest('hex'),
    })
    expect(manifest.manifestSha256).toBe(
      createHash('sha256').update(manifest.canonicalJsonl).digest('hex'),
    )
    expect(new TextDecoder().decode(manifest.canonicalJsonl).endsWith('\n')).toBe(true)
    assertManifestTransferable(manifest)
  })

  it('reports built-in exclusions without reading excluded directory contents', async () => {
    const directory = await root()
    await mkdir(join(directory, '.git'))
    await writeFile(join(directory, '.git', 'config'), 'must not enter manifest')
    await writeFile(join(directory, '.env.local'), 'private material')
    const manifest = await scanSourceManifest(directory)
    expect(manifest.entries).toEqual([
      expect.objectContaining({
        path: '.env.local',
        sha256: null,
        exclusionReason: 'secret-environment',
      }),
      expect.objectContaining({ path: '.git', sha256: null, exclusionReason: 'git-metadata' }),
    ])
    expect(new TextDecoder().decode(manifest.canonicalJsonl)).not.toContain('config')
    expect(new TextDecoder().decode(manifest.canonicalJsonl)).not.toContain('private material')
  })

  it('refuses symlinks without dereferencing their target', async () => {
    const directory = await root()
    const outside = await root()
    await writeFile(join(outside, 'outside.txt'), 'outside data')
    await symlink(outside, join(directory, 'link'), 'junction')
    const manifest = await scanSourceManifest(directory)
    expect(manifest.blocked).toEqual([{ path: 'link', reason: 'symlink' }])
    expect(manifest.entries).toEqual([])
    expect(() => assertManifestTransferable(manifest)).toThrow(SourceManifestBlockedError)
  })

  it('fails closed on size and file-count caps before transfer', async () => {
    const directory = await root()
    await writeFile(join(directory, 'a.txt'), '1234')
    await writeFile(join(directory, 'b.txt'), '5678')
    const manifest = await scanSourceManifest(directory, {
      maxBytes: 5,
      maxFileBytes: 3,
      maxFiles: 1,
    })
    expect(manifest.transferableFiles).toBe(0)
    expect(manifest.totalBytes).toBe(0)
    expect(manifest.blocked).toEqual([
      { path: 'a.txt', reason: 'size-limit' },
      { path: 'b.txt', reason: 'size-limit' },
    ])
  })

  it('rejects case-colliding portable paths', async () => {
    const directory = await root()
    await writeFile(join(directory, 'Readme'), 'one')
    await writeFile(join(directory, 'README'), 'two')
    const manifest = await scanSourceManifest(directory)
    const distinctNamesExist = (await readdir(directory)).length === 2
    if (distinctNamesExist) {
      expect(manifest.collisions).toHaveLength(1)
      expect(manifest.collisions[0]?.kind).toBe('case')
      expect(() => assertManifestTransferable(manifest)).toThrow(SourceManifestBlockedError)
    } else {
      // Case-insensitive filesystems cannot contain the hostile fixture at all.
      expect(manifest.collisions).toEqual([])
    }
  })
})

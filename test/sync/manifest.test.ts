import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertManifestTransferable,
  MAX_SYNC_BLOCKED,
  MAX_SYNC_DIRECTORIES,
  MAX_SYNC_ENTRIES,
  MAX_SYNC_FILES,
  nanosecondMtimeHint,
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
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { force: true, maxRetries: 5, recursive: true })),
  )
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

  it('caps directory entries so a directory-only tree cannot exhaust memory', async () => {
    const directory = await root()
    await mkdir(join(directory, 'a'))
    await mkdir(join(directory, 'b'))
    const manifest = await scanSourceManifest(directory, { maxDirectories: 1 })
    expect(manifest.blocked).toEqual([{ path: 'b', reason: 'entry-limit' }])
    expect(manifest.entries.map((entry) => entry.path)).toEqual(['a'])
    expect(() => assertManifestTransferable(manifest)).toThrow(SourceManifestBlockedError)
  })

  it('bounds total snapshot entries by files plus directories', () => {
    expect(MAX_SYNC_ENTRIES).toBe(MAX_SYNC_FILES + MAX_SYNC_DIRECTORIES)
    expect(MAX_SYNC_ENTRIES).toBeGreaterThan(MAX_SYNC_FILES)
  })

  it('keeps excluded-file metadata inside the shared entry budget', async () => {
    const directory = await root()
    await writeFile(join(directory, '.env.a'), 'a')
    await writeFile(join(directory, '.env.b'), 'b')
    const manifest = await scanSourceManifest(directory, {
      maxFiles: 1,
      maxDirectories: 0,
    })
    expect(manifest.blocked).toEqual([{ path: '.env.b', reason: 'entry-limit' }])
    expect(manifest.entries).toEqual([
      expect.objectContaining({ path: '.env.a', exclusionReason: 'secret-environment' }),
    ])
    expect(manifest.blockedOverflow).toBe(false)
  })

  it('caps the blocked report and flags the overflow instead of growing without bound', async () => {
    const directory = await root()
    const names = Array.from(
      { length: MAX_SYNC_BLOCKED + 5 },
      (_, index) => `item-${String(index).padStart(5, '0')}.bin`,
    )
    for (let offset = 0; offset < names.length; offset += 250) {
      await Promise.all(
        names.slice(offset, offset + 250).map((name) => writeFile(join(directory, name), 'x')),
      )
    }
    const manifest = await scanSourceManifest(directory, {
      maxBytes: 0,
      maxFileBytes: 0,
      maxFiles: 0,
    })
    expect(manifest.blocked).toHaveLength(MAX_SYNC_BLOCKED)
    expect(manifest.blockedOverflow).toBe(true)
    // The surviving report must remain deterministic (bytewise sorted paths).
    const sorted = [...manifest.blocked].sort((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
    )
    expect(manifest.blocked.every((entry, index) => entry === sorted[index])).toBe(true)
  }, 30_000)

  it('clamps non-finite or pre-epoch mtime hints instead of crashing', () => {
    expect(nanosecondMtimeHint(Number.NaN)).toBe('0')
    expect(nanosecondMtimeHint(Number.POSITIVE_INFINITY)).toBe('0')
    expect(nanosecondMtimeHint(-4.2)).toBe('0')
    expect(nanosecondMtimeHint(0)).toBe('0')
    expect(nanosecondMtimeHint(1)).toBe('1000000')
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

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

  it('admits entries in canonical byte order instead of filesystem enumeration order', async () => {
    const directory = await root()
    const directories = ['d00', 'd01', 'd02', 'd03']
    const files = ['f00', 'f01', 'f02', 'f03']
    // Reverse creation order: `opendir` enumeration order and byte order
    // disagree, so an order-dependent scan admits the wrong four entries.
    for (const name of [...files, ...directories].toReversed()) {
      if (name.startsWith('d')) await mkdir(join(directory, name))
      else await writeFile(join(directory, name), 'x')
    }
    const manifest = await scanSourceManifest(directory, { maxDirectories: 2, maxFiles: 2 })
    expect(manifest.entries.map((entry) => entry.path)).toEqual(['d00', 'd01', 'f00', 'f01'])
    expect(manifest.blocked).toEqual([
      { path: 'd02', reason: 'entry-limit' },
      { path: 'd03', reason: 'entry-limit' },
      { path: 'f02', reason: 'file-limit' },
      { path: 'f03', reason: 'file-limit' },
    ])
    expect(manifest.blockedOverflow).toBe(false)
  })

  it('admits the canonical depth-first prefix across nested directories', async () => {
    const directory = await root()
    // Canonical depth-first order is a-tree, a-tree/a-inner, a-tree/z.txt,
    // b-tree, b-tree/b-inner, b-tree/y.txt, c.txt; every level is created in
    // reverse so enumeration order cannot produce that prefix by accident.
    await writeFile(join(directory, 'c.txt'), 'c')
    await mkdir(join(directory, 'b-tree'))
    await writeFile(join(directory, 'b-tree', 'y.txt'), 'y')
    await mkdir(join(directory, 'b-tree', 'b-inner'))
    await mkdir(join(directory, 'a-tree'))
    await writeFile(join(directory, 'a-tree', 'z.txt'), 'z')
    await mkdir(join(directory, 'a-tree', 'a-inner'))

    const manifest = await scanSourceManifest(directory, { maxDirectories: 3, maxFiles: 2 })
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      'a-tree',
      'a-tree/a-inner',
      'a-tree/z.txt',
      'b-tree',
      'b-tree/y.txt',
    ])
    expect(manifest.blocked).toEqual([
      { path: 'b-tree/b-inner', reason: 'entry-limit' },
      { path: 'c.txt', reason: 'file-limit' },
    ])
  })

  it('reproduces the manifest of an identical tree built in reverse creation order', async () => {
    const forward = await root()
    const reverse = await root()
    const fixture = [
      { path: 'd-a', type: 'directory' },
      { path: 'd-a/inner', type: 'directory' },
      { path: 'd-a/x.txt', type: 'file' },
      { path: 'd-b', type: 'directory' },
      { path: 'd-b/y.txt', type: 'file' },
      { path: 'z.txt', type: 'file' },
    ] as const
    async function build(
      target: string,
      entries: readonly { readonly path: string; readonly type: string }[],
    ): Promise<void> {
      for (const entry of entries) {
        const fullPath = join(target, entry.path)
        if (entry.type === 'directory') await mkdir(fullPath, { recursive: true })
        else {
          // The reversed order writes children before their parents.
          await mkdir(dirname(fullPath), { recursive: true })
          await writeFile(fullPath, entry.path)
        }
      }
    }
    await build(forward, fixture)
    await build(reverse, fixture.toReversed())
    // Identity hashes carry no mtime, but the entry list does, so both trees
    // need the same timestamps before their serialized forms can be compared.
    const stamp = new Date('2024-01-01T00:00:00.000Z')
    for (const entry of fixture) {
      await utimes(join(forward, entry.path), stamp, stamp)
      await utimes(join(reverse, entry.path), stamp, stamp)
    }

    const options = { maxDirectories: 2, maxFiles: 1 }
    const forwardManifest = await scanSourceManifest(forward, options)
    const reverseManifest = await scanSourceManifest(reverse, options)
    expect(forwardManifest.entries.map((entry) => entry.path)).toEqual([
      'd-a',
      'd-a/inner',
      'd-a/x.txt',
    ])
    // A blocked directory is never entered, so its children stay unreported.
    expect(forwardManifest.blocked).toEqual([
      { path: 'd-b', reason: 'entry-limit' },
      { path: 'z.txt', reason: 'file-limit' },
    ])
    expect(reverseManifest.entries).toEqual(forwardManifest.entries)
    expect(reverseManifest.blocked).toEqual(forwardManifest.blocked)
    expect(reverseManifest.manifestSha256).toBe(forwardManifest.manifestSha256)
    expect(new TextDecoder().decode(reverseManifest.canonicalJsonl)).toBe(
      new TextDecoder().decode(forwardManifest.canonicalJsonl),
    )
  })

  it('keeps the caps binding when a tree exceeds them', async () => {
    const directory = await root()
    const directories = Array.from(
      { length: 6 },
      (_, index) => `dir-${String(index).padStart(2, '0')}`,
    )
    const files = Array.from(
      { length: 6 },
      (_, index) => `file-${String(index).padStart(2, '0')}.bin`,
    )
    // Reverse creation order again: the admitted prefix must not depend on it.
    for (const name of [...files, ...directories].toReversed()) {
      if (name.startsWith('dir-')) await mkdir(join(directory, name))
      else await writeFile(join(directory, name), 'x')
    }
    const manifest = await scanSourceManifest(directory, { maxDirectories: 2, maxFiles: 3 })
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      'dir-00',
      'dir-01',
      'file-00.bin',
      'file-01.bin',
      'file-02.bin',
    ])
    expect(manifest.entries.filter((entry) => entry.type === 'directory')).toHaveLength(2)
    expect(manifest.transferableFiles).toBe(3)
    expect(manifest.totalBytes).toBe(3)
    expect(manifest.blocked).toEqual([
      { path: 'dir-02', reason: 'entry-limit' },
      { path: 'dir-03', reason: 'entry-limit' },
      { path: 'dir-04', reason: 'entry-limit' },
      { path: 'dir-05', reason: 'entry-limit' },
      { path: 'file-03.bin', reason: 'file-limit' },
      { path: 'file-04.bin', reason: 'file-limit' },
      { path: 'file-05.bin', reason: 'file-limit' },
    ])
    expect(manifest.blockedOverflow).toBe(false)
  })

  it('orders a listing larger than one window without materializing it', async () => {
    const directory = await root()
    // Above the 4096-name listing window in `src/sync/manifest.ts`, so reaching
    // the lexicographically first names requires a second ordered pass over
    // the directory instead of one full listing. Raise both values together.
    const names = Array.from({ length: 4_200 }, (_, index) => `f${String(index).padStart(4, '0')}`)
    for (let offset = names.length; offset > 0; offset -= 250) {
      const start = Math.max(offset - 250, 0)
      await Promise.all(
        names.slice(start, offset).map((name) => writeFile(join(directory, name), 'x')),
      )
    }
    const manifest = await scanSourceManifest(directory, { maxDirectories: 0, maxFiles: 3 })
    expect(manifest.entries.map((entry) => entry.path)).toEqual(['f0000', 'f0001', 'f0002'])
    expect(manifest.blocked.map((entry) => entry.path)).toEqual(names.slice(3))
    expect(manifest.blocked.every((entry) => entry.reason === 'file-limit')).toBe(true)
    expect(manifest.blockedOverflow).toBe(false)
  }, 30_000)

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

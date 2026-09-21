import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseManifestContent, writeFileAtomic } from '../../../src/agents/claude-code/store.js'

describe('claude-code store durability and manifest parsing', () => {
  it('preserves an existing file mode when atomically rewriting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocbox-t11-store-'))
    try {
      const target = join(dir, 'settings.json')
      await writeFile(target, '{"a":1}', 'utf8')
      await chmod(target, 0o644)
      await writeFileAtomic(target, '{"a":2}')
      expect(await readFile(target, 'utf8')).toBe('{"a":2}')
      if (process.platform !== 'win32') {
        const info = await stat(target)
        expect(info.mode & 0o777).toBe(0o644)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes a new file with owner-only permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocbox-t11-store-'))
    try {
      const target = join(dir, 'fresh.json')
      await writeFileAtomic(target, '{"fresh":true}')
      if (process.platform !== 'win32') {
        const info = await stat(target)
        expect(info.mode & 0o777).toBe(0o600)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a manifest that omits pinnedVersion instead of inventing one', () => {
    const missing = JSON.stringify({
      adapter: 'claude-code',
      targetPath: '/tmp/settings.json',
      baseHash: 'a',
      appliedHash: 'b',
    })
    expect(parseManifestContent(missing)).toBeNull()
    const present = JSON.stringify({
      adapter: 'claude-code',
      pinnedVersion: '2.0.51',
      targetPath: '/tmp/settings.json',
      baseHash: 'a',
      appliedHash: 'b',
    })
    expect(parseManifestContent(present)?.pinnedVersion).toBe('2.0.51')
  })
})

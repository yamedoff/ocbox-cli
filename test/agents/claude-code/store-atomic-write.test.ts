import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A single mutable rename probe shared with the hoisted module mock: the first
// rename can be forced to fail with a non-retryable code so the test can prove
// `writeFileAtomic` makes exactly one replacement attempt (no duplicate
// atomic-rename fallback) and cleans up its temporary file (L5).
const renameProbe = vi.hoisted(() => ({ attempts: 0, failFirst: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (source: string, destination: string) => {
      renameProbe.attempts += 1
      if (renameProbe.failFirst && renameProbe.attempts === 1) {
        const error = new Error('simulated cross-device rename failure') as NodeJS.ErrnoException
        // EXDEV is never retried by `replaceFileAtomically` on any platform, so
        // the probe behaves identically on Linux, macOS, and Windows.
        error.code = 'EXDEV'
        throw error
      }
      return actual.rename(source, destination)
    },
  }
})

const { writeFileAtomic } = await import('../../../src/agents/claude-code/store.js')

describe('claude-code atomic write failure path (L5)', () => {
  beforeEach(() => {
    renameProbe.attempts = 0
    renameProbe.failFirst = false
  })

  it('replaces an existing target with exactly one atomic rename on success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocbox-t11-atomic-'))
    try {
      const target = join(dir, 'settings.json')
      await writeFile(target, '{"before":true}', 'utf8')
      await writeFileAtomic(target, '{"after":true}')
      expect(renameProbe.attempts).toBe(1)
      expect(await readFile(target, 'utf8')).toBe('{"after":true}')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('makes a single documented attempt and cleans up when the atomic replace fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocbox-t11-atomic-'))
    try {
      const target = join(dir, 'settings.json')
      await writeFile(target, '{"before":true}', 'utf8')
      renameProbe.failFirst = true
      await expect(writeFileAtomic(target, '{"after":true}')).rejects.toThrow(
        /cross-device rename failure/,
      )
      // Exactly one attempt: the removed fallback used to issue a second rename.
      expect(renameProbe.attempts).toBe(1)
      // The pre-existing target is untouched and no temporary file is leaked.
      expect(await readFile(target, 'utf8')).toBe('{"before":true}')
      expect((await readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

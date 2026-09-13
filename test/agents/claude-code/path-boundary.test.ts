import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeSettingsPathBoundaryError } from '../../../src/agents/claude-code/path-boundary.js'
import {
  liveFileAccess,
  planDoctor,
  planRemove,
  planSetup,
} from '../../../src/agents/claude-code/planner.js'
import {
  resolveClaudeSettingsLayout,
  targetPathForScope,
} from '../../../src/agents/claude-code/settings-sources.js'

const PINNED = '2.0.51 (Claude Code)'
const SESSION = '11111111-1111-4111-8111-111111111111'

function canCreateDirectoryLink(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'ocbox-t11-linkprobe-'))
  try {
    mkdirSync(join(root, 'target'))
    symlinkSync(join(root, 'target'), join(root, 'link'), 'junction')
    return true
  } catch {
    return false
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function canCreateFileLink(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'ocbox-t11-fileprobe-'))
  try {
    writeFileSync(join(root, 'target.json'), '{}')
    symlinkSync(join(root, 'target.json'), join(root, 'link.json'), 'file')
    return true
  } catch {
    return false
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const CAN_DIRECTORY_LINK = canCreateDirectoryLink()
const CAN_FILE_LINK = canCreateFileLink()

function layoutFor(root: string) {
  return resolveClaudeSettingsLayout({
    homeDirectory: join(root, 'home'),
    projectDirectory: join(root, 'proj'),
    platformOverride: process.platform,
    managedPathOverride: null,
  })
}

function optionsFor(root: string, scope: 'user' | 'project' | 'local' = 'project') {
  return {
    layout: layoutFor(root),
    scope,
    sessionId: SESSION,
    claudeVersionRaw: PINNED,
    files: liveFileAccess(),
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('claude-code settings path boundary', () => {
  it.skipIf(!CAN_DIRECTORY_LINK)(
    'refuses setup, doctor, and remove when .claude is a directory link escaping the project',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocbox-t11-boundary-'))
      try {
        const project = join(root, 'proj')
        const outside = join(root, 'outside')
        await mkdir(project, { recursive: true })
        await mkdir(outside, { recursive: true })
        await symlink(outside, join(project, '.claude'), 'junction')

        await expect(planSetup(optionsFor(root))).rejects.toThrow(ClaudeSettingsPathBoundaryError)
        await expect(planDoctor(optionsFor(root))).rejects.toThrow(ClaudeSettingsPathBoundaryError)
        await expect(planRemove({ ...optionsFor(root), sessionId: null })).rejects.toThrow(
          ClaudeSettingsPathBoundaryError,
        )
        expect(await exists(join(outside, 'settings.json'))).toBe(false)
        expect(await exists(join(outside, 'ocbox-claude-code-manifest.json'))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!CAN_DIRECTORY_LINK)(
    'refuses user-scope setup when ~/.claude is a directory link escaping home',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocbox-t11-boundary-user-'))
      try {
        const home = join(root, 'home')
        const outside = join(root, 'outside')
        await mkdir(home, { recursive: true })
        await mkdir(outside, { recursive: true })
        await symlink(outside, join(home, '.claude'), 'junction')

        await expect(planSetup(optionsFor(root, 'user'))).rejects.toThrow(
          ClaudeSettingsPathBoundaryError,
        )
        expect(await exists(join(outside, 'settings.json'))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!CAN_DIRECTORY_LINK)(
    'does not follow a .claude directory link that leaves the settings root',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocbox-t11-boundary-inside-'))
      try {
        const project = join(root, 'proj')
        await mkdir(join(project, 'shared'), { recursive: true })
        await symlink(join(project, 'shared'), join(project, '.claude'), 'junction')

        await expect(planSetup(optionsFor(root))).rejects.toThrow(ClaudeSettingsPathBoundaryError)
        expect(await exists(join(project, 'shared', 'settings.json'))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform === 'win32' || !CAN_FILE_LINK)(
    'refuses a symlinked settings file that escapes .claude (POSIX)',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocbox-t11-boundary-file-'))
      try {
        const project = join(root, 'proj')
        const secret = join(root, 'secret.json')
        await mkdir(join(project, '.claude'), { recursive: true })
        await writeFile(secret, '{"secret":true}', 'utf8')
        await symlink(secret, join(project, '.claude', 'settings.json'), 'file')

        await expect(planSetup(optionsFor(root))).rejects.toThrow(ClaudeSettingsPathBoundaryError)
        await expect(planDoctor(optionsFor(root))).rejects.toThrow(ClaudeSettingsPathBoundaryError)
        await expect(planRemove({ ...optionsFor(root), sessionId: null })).rejects.toThrow(
          ClaudeSettingsPathBoundaryError,
        )
        expect(await readFile(secret, 'utf8')).toBe('{"secret":true}')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('round-trips a real, non-linked settings file byte-for-byte through live access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocbox-t11-live-'))
    try {
      const project = join(root, 'proj')
      await mkdir(join(project, '.claude'), { recursive: true })
      const layout = layoutFor(root)
      const target = targetPathForScope(layout, 'project')
      const original = '{\r\n\t"permissions": {"allow": ["Bash(ls)"]}\r\n}\r\n'
      await writeFile(target, original, 'utf8')

      const setup = await planSetup(optionsFor(root))
      expect(setup.status).toBe('applied')
      expect(await readFile(target, 'utf8')).not.toBe(original)

      const removed = await planRemove({ ...optionsFor(root), sessionId: null })
      expect(removed.status).toBe('removed')
      expect(await readFile(target, 'utf8')).toBe(original)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

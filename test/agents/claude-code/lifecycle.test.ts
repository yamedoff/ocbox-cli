import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type PlannerFileAccess,
  liveFileAccess,
  planDoctor,
  planRemove,
  planSetup,
} from '../../../src/agents/claude-code/planner.js'
import {
  resolveClaudeSettingsLayout,
  targetPathForScope,
} from '../../../src/agents/claude-code/settings-sources.js'
import {
  backupPathForTarget,
  MANIFEST_FILENAME,
  manifestPathForTarget,
} from '../../../src/agents/claude-code/store.js'

const PINNED = '2.0.51 (Claude Code)'
const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'

function memoryFiles(
  seed: Record<string, string> = {},
): PlannerFileAccess & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    store,
    readText: async (path: string) => store.get(path) ?? null,
    writeText: async (path: string, content: string) => {
      store.set(path, content)
    },
    removePath: async (path: string) => {
      store.delete(path)
    },
    now: () => new Date('2026-09-12T00:00:00.000Z'),
  }
}

function projectLayout(root: string) {
  return resolveClaudeSettingsLayout({
    homeDirectory: join(root, 'home'),
    projectDirectory: join(root, 'proj'),
    platformOverride: process.platform,
    managedPathOverride: null,
  })
}

describe('claude-code setup/doctor/remove lifecycle', () => {
  it('runs setup to remove round-trip on temp fixtures only', async () => {
    const files = memoryFiles()
    const dir = await mkdtemp(join(tmpdir(), 'ocbox-t11-'))
    try {
      const layout = resolveClaudeSettingsLayout({
        homeDirectory: join(dir, 'home'),
        projectDirectory: join(dir, 'proj'),
        platformOverride: 'linux',
        managedPathOverride: null,
      })
      const setup = await planSetup({
        layout,
        scope: 'project',
        sessionId: SESSION_A,
        claudeVersionRaw: PINNED,
        files,
      })
      expect(setup.status).toBe('applied')
      const repeat = await planSetup({
        layout,
        scope: 'project',
        sessionId: SESSION_A,
        claudeVersionRaw: PINNED,
        files,
      })
      expect(repeat.status).toBe('already-applied')
      const doctor = await planDoctor({
        layout,
        scope: 'project',
        sessionId: SESSION_A,
        claudeVersionRaw: PINNED,
        files,
      })
      expect(
        doctor.findings.some((finding) => finding.check === 'owned-entries' && finding.ok),
      ).toBe(true)
      expect(doctor.findings.some((finding) => finding.check === 'drift' && !finding.ok)).toBe(
        false,
      )
      expect(doctor.capabilityMatrix.length).toBeGreaterThanOrEqual(8)
      const removed = await planRemove({
        layout,
        scope: 'project',
        sessionId: null,
        claudeVersionRaw: PINNED,
        files,
      })
      expect(removed.status).toBe('removed')
      const again = await planRemove({
        layout,
        scope: 'project',
        sessionId: null,
        claudeVersionRaw: PINNED,
        files,
      })
      expect(again.status).toBe('not-installed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails setup closed on version mismatch and managed locks', async () => {
    const files = memoryFiles()
    const fakeManaged = join('fake-root', 'managed.json')
    const layout = resolveClaudeSettingsLayout({
      homeDirectory: join('fake-root', 'h'),
      projectDirectory: join('fake-root', 'p'),
      platformOverride: 'linux',
      managedPathOverride: fakeManaged,
    })
    await expect(
      planSetup({
        layout,
        scope: 'project',
        sessionId: SESSION_A,
        claudeVersionRaw: '9.9.9',
        files,
      }),
    ).rejects.toThrow()
    const locked = memoryFiles({ [fakeManaged]: '{"allowManagedHooksOnly": true}' })
    await expect(
      planSetup({
        layout,
        scope: 'project',
        sessionId: SESSION_A,
        claudeVersionRaw: PINNED,
        files: locked,
      }),
    ).rejects.toThrow(/Managed policy/)
  })

  it('detects drift and produces a three-way repair plan on user edits', async () => {
    const files = memoryFiles()
    const layout = resolveClaudeSettingsLayout({
      homeDirectory: join('fake-root', 'h'),
      projectDirectory: join('fake-root', 'p'),
      platformOverride: 'linux',
      managedPathOverride: null,
    })
    await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    const projectTarget = targetPathForScope(layout, 'project')
    const current = JSON.parse(files.store.get(projectTarget) as string) as Record<string, unknown>
    current['userNote'] = 'edited by hand'
    files.store.set(projectTarget, JSON.stringify(current))
    const doctor = await planDoctor({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(doctor.findings.some((finding) => finding.check === 'drift' && !finding.ok)).toBe(true)
    const removed = await planRemove({
      layout,
      scope: 'project',
      sessionId: null,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(removed.status).toBe('removed')
    expect(removed.repairPlan.join(' ').toLowerCase()).toContain('three-way')
    const restored = JSON.parse(files.store.get(projectTarget) as string) as Record<string, unknown>
    expect(restored['userNote']).toBe('edited by hand')
  })

  it('reports corruption and missing sessions honestly in doctor', async () => {
    const files = memoryFiles()
    const layout = resolveClaudeSettingsLayout({
      homeDirectory: join('fake-root', 'h'),
      projectDirectory: join('fake-root', 'p'),
      platformOverride: 'linux',
      managedPathOverride: null,
    })
    files.store.set(targetPathForScope(layout, 'project'), '{oops')
    const doctor = await planDoctor({
      layout,
      scope: 'project',
      sessionId: null,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(doctor.ok).toBe(false)
    expect(doctor.findings.some((finding) => finding.check === 'session' && !finding.ok)).toBe(true)
    expect(doctor.findings.some((finding) => !finding.ok && finding.detail.includes('JSON'))).toBe(
      true,
    )
  })

  it('never writes hook files outside settings and keeps backups atomic', async () => {
    const layout = resolveClaudeSettingsLayout({
      homeDirectory: join('fake-root', 'h'),
      projectDirectory: join('fake-root', 'p'),
      platformOverride: 'linux',
      managedPathOverride: null,
    })
    const files = memoryFiles({
      [targetPathForScope(layout, 'project')]: '{"permissions": {"allow": []}}',
    })
    const setup = await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(setup.backupPath).not.toBeNull()
    expect([...files.store.keys()].some((key) => key.endsWith('hooks.json'))).toBe(false)
    expect(backupPathForTarget(targetPathForScope(layout, 'project')).endsWith('.json')).toBe(true)
    const backup = files.store.get(setup.backupPath as string)
    expect(backup).toContain('permissions')
  })

  it('fails closed when an explicit overlay denies the owned router', async () => {
    const explicitPath = join('fake-root', 'explicit.json')
    const layout = resolveClaudeSettingsLayout({
      homeDirectory: join('fake-root', 'h'),
      projectDirectory: join('fake-root', 'p'),
      platformOverride: 'linux',
      managedPathOverride: null,
      explicitPaths: [explicitPath],
    })
    const files = memoryFiles({
      [explicitPath]: '{"permissions": {"deny": ["Bash(ocbox exec:*)"]}}',
    })
    await expect(
      planSetup({
        layout,
        scope: 'project',
        sessionId: SESSION_A,
        claudeVersionRaw: PINNED,
        files,
      }),
    ).rejects.toThrow(/shadows the owned router|Managed policy/)
    expect(files.store.has(targetPathForScope(layout, 'project'))).toBe(false)
  })

  it('refuses to install an invalid Session and never writes the target (N2)', async () => {
    const files = memoryFiles()
    const layout = projectLayout('fake-root')
    const target = targetPathForScope(layout, 'project')
    await expect(
      planSetup({
        layout,
        scope: 'project',
        sessionId: 'sess-1',
        claudeVersionRaw: PINNED,
        files,
      }),
    ).rejects.toThrow(/not a valid Session ID/)
    expect(files.store.has(target)).toBe(false)
    expect(files.store.has(manifestPathForTarget(target))).toBe(false)
  })

  it('reports an invalid Session as unhealthy in doctor (N2)', async () => {
    const files = memoryFiles()
    const layout = projectLayout('fake-root')
    const doctor = await planDoctor({
      layout,
      scope: 'project',
      sessionId: 'sess-1',
      claudeVersionRaw: PINNED,
      files,
    })
    expect(doctor.ok).toBe(false)
    const finding = doctor.findings.find((entry) => entry.check === 'session')
    expect(finding?.ok).toBe(false)
    expect(finding?.detail).toContain('not a valid Session ID')
  })

  it('rolls back the target when the manifest write fails', async () => {
    const layout = resolveClaudeSettingsLayout({
      homeDirectory: join('fake-root', 'h'),
      projectDirectory: join('fake-root', 'p'),
      platformOverride: 'linux',
      managedPathOverride: null,
    })
    const target = targetPathForScope(layout, 'project')
    const before = '{"permissions": {"allow": []}}'
    const files = memoryFiles({ [target]: before })
    let calls = 0
    const failing = {
      ...files,
      writeText: async (path: string, content: string) => {
        calls += 1
        if (path.endsWith('ocbox-claude-code-manifest.json')) throw new Error('disk full')
        await files.writeText(path, content)
      },
    }
    await expect(
      planSetup({
        layout,
        scope: 'project',
        sessionId: SESSION_A,
        claudeVersionRaw: PINNED,
        files: failing,
      }),
    ).rejects.toThrow(/disk full/)
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(files.store.get(target)).toBe(before)
  })

  it('deletes the adapter-created settings file on fresh remove instead of leaving {} (N3)', async () => {
    const files = memoryFiles()
    const layout = resolveClaudeSettingsLayout({
      homeDirectory: join('fake-root', 'h'),
      projectDirectory: join('fake-root', 'p'),
      platformOverride: 'linux',
      managedPathOverride: null,
    })
    await planSetup({
      layout,
      scope: 'user',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    const target = targetPathForScope(layout, 'user')
    expect(files.store.has(target)).toBe(true)
    const removed = await planRemove({
      layout,
      scope: 'user',
      sessionId: null,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(removed.status).toBe('removed')
    expect(files.store.has(target)).toBe(false)
    expect(files.store.has(manifestPathForTarget(target))).toBe(false)
  })

  it('restores a pre-existing file byte-for-byte instead of deleting it (N3)', async () => {
    const layout = projectLayout('fake-root')
    const target = targetPathForScope(layout, 'project')
    const originalRaw = `${JSON.stringify(
      { cleanupPeriodDays: 30, permissions: { allow: ['Bash(ls)'] } },
      null,
      2,
    )}\n`
    const files = memoryFiles({ [target]: originalRaw })
    await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(files.store.has(target)).toBe(true)
    const removed = await planRemove({
      layout,
      scope: 'project',
      sessionId: null,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(removed.status).toBe('removed')
    expect(files.store.get(target)).toBe(originalRaw)
    expect(files.store.has(manifestPathForTarget(target))).toBe(false)
  })

  it('keeps a pre-existing empty {} file instead of deleting it (N3 boundary)', async () => {
    const layout = projectLayout('fake-root')
    const target = targetPathForScope(layout, 'project')
    const originalRaw = '{}\n'
    const files = memoryFiles({ [target]: originalRaw })
    await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    const removed = await planRemove({
      layout,
      scope: 'project',
      sessionId: null,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(removed.status).toBe('removed')
    expect(files.store.has(target)).toBe(true)
    expect(files.store.get(target)).toBe(originalRaw)
  })

  it('restores exact user bytes on setup-remove, including absent deny/ask (H6)', async () => {
    const layout = projectLayout('fake-root')
    const target = targetPathForScope(layout, 'project')
    const original = {
      alwaysThinkingEnabled: true,
      permissions: { allow: ['Bash(npm test *)'] },
      custom: { nested: [1, 2, 3] },
    }
    const originalRaw = `${JSON.stringify(original, null, 2)}\n`
    const files = memoryFiles({ [target]: originalRaw })
    await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    const installed = JSON.parse(files.store.get(target) as string) as Record<string, unknown>
    const installedPermissions = installed['permissions'] as Record<string, unknown>
    expect(installedPermissions['deny']).toBeUndefined()
    expect(installedPermissions['ask']).toBeUndefined()
    const removed = await planRemove({
      layout,
      scope: 'project',
      sessionId: null,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(removed.status).toBe('removed')
    expect(files.store.get(target)).toBe(originalRaw)
  })

  it('removes the orphan target file on fresh-install rollback with live access (H7)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocbox-t11-live-'))
    try {
      const layout = projectLayout(root)
      const target = targetPathForScope(layout, 'project')
      const live = liveFileAccess()
      const files: PlannerFileAccess = {
        readText: live.readText,
        removePath: async (path) => {
          await live.removePath?.(path)
        },
        writeText: async (path, content) => {
          if (path.endsWith(MANIFEST_FILENAME)) throw new Error('manifest boom')
          await live.writeText(path, content)
        },
      }
      await expect(
        planSetup({
          layout,
          scope: 'project',
          sessionId: SESSION_A,
          claudeVersionRaw: PINNED,
          files,
        }),
      ).rejects.toThrow(/manifest boom/)
      expect(await live.readText(target)).toBeNull()
      expect(await live.readText(manifestPathForTarget(target))).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a healthy removed state in doctor after a clean remove (H8)', async () => {
    const files = memoryFiles()
    const layout = projectLayout('fake-root')
    const target = targetPathForScope(layout, 'project')
    await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    const removed = await planRemove({
      layout,
      scope: 'project',
      sessionId: null,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(removed.status).toBe('removed')
    expect(files.store.has(manifestPathForTarget(target))).toBe(false)
    const doctor = await planDoctor({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(doctor.ok).toBe(true)
    expect(
      doctor.findings.some(
        (finding) =>
          finding.check === 'owned-entries' && finding.ok && finding.detail.includes('removed'),
      ),
    ).toBe(true)
    expect(doctor.findings.some((finding) => finding.check === 'drift')).toBe(false)
  })

  it('rotates to a new Session on re-setup and flags a stale Session in doctor (H9)', async () => {
    const files = memoryFiles()
    const layout = projectLayout('fake-root')
    const target = targetPathForScope(layout, 'project')
    await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    const rotated = await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_B,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(rotated.status).toBe('applied')
    const document = files.store.get(target) as string
    expect(document).toContain(`--session ${SESSION_B}`)
    expect(document).not.toContain(`--session ${SESSION_A}`)
    const manifest = JSON.parse(files.store.get(manifestPathForTarget(target)) as string) as Record<
      string,
      unknown
    >
    expect(manifest['sessionId']).toBe(SESSION_B)
    const healthy = await planDoctor({
      layout,
      scope: 'project',
      sessionId: SESSION_B,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(healthy.ok).toBe(true)
    const stale = await planDoctor({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(stale.ok).toBe(false)
    expect(stale.findings.some((finding) => finding.check === 'session' && !finding.ok)).toBe(true)
  })
})

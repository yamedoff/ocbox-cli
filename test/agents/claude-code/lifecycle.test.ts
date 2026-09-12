import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type PlannerFileAccess,
  planDoctor,
  planRemove,
  planSetup,
} from '../../../src/agents/claude-code/planner.js'
import {
  resolveClaudeSettingsLayout,
  targetPathForScope,
} from '../../../src/agents/claude-code/settings-sources.js'
import { backupPathForTarget } from '../../../src/agents/claude-code/store.js'

const PINNED = '2.0.51 (Claude Code)'

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
    now: () => new Date('2026-09-12T00:00:00.000Z'),
  }
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
        sessionId: 'sess-1',
        claudeVersionRaw: PINNED,
        files,
      })
      expect(setup.status).toBe('applied')
      const repeat = await planSetup({
        layout,
        scope: 'project',
        sessionId: 'sess-1',
        claudeVersionRaw: PINNED,
        files,
      })
      expect(repeat.status).toBe('already-applied')
      const doctor = await planDoctor({
        layout,
        scope: 'project',
        sessionId: 'sess-1',
        claudeVersionRaw: PINNED,
        files,
      })
      expect(
        doctor.findings.some((finding) => finding.check === 'owned-entries' && finding.ok),
      ).toBe(true)
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
      planSetup({ layout, scope: 'project', sessionId: 's', claudeVersionRaw: '9.9.9', files }),
    ).rejects.toThrow()
    const locked = memoryFiles({ [fakeManaged]: '{"allowManagedHooksOnly": true}' })
    await expect(
      planSetup({
        layout,
        scope: 'project',
        sessionId: 's',
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
      sessionId: 'sess-1',
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
      sessionId: 'sess-1',
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
      sessionId: 's',
      claudeVersionRaw: PINNED,
      files,
    })
    expect(setup.backupPath).not.toBeNull()
    expect([...files.store.keys()].some((key) => key.endsWith('hooks.json'))).toBe(false)
    expect(backupPathForTarget(targetPathForScope(layout, 'project')).endsWith('.json')).toBe(true)
    const backup = files.store.get(setup.backupPath as string)
    expect(backup).toContain('permissions')
    await readFile(new URL('../../../package.json', import.meta.url), 'utf8')
  })
})

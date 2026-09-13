import { describe, expect, it } from 'vitest'
import { planMerge } from '../../../src/agents/claude-code/merge.js'
import {
  type PlannerFileAccess,
  planDoctor,
  planRemove,
  planSetup,
} from '../../../src/agents/claude-code/planner.js'
import {
  OWNED_PERMISSION_ALLOW,
  type ClaudeSettingsDocument,
} from '../../../src/agents/claude-code/settings-model.js'
import {
  resolveClaudeSettingsLayout,
  targetPathForScope,
} from '../../../src/agents/claude-code/settings-sources.js'
import { manifestPathForTarget } from '../../../src/agents/claude-code/store.js'

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

function projectLayout() {
  return resolveClaudeSettingsLayout({
    homeDirectory: 'fake-root/h',
    projectDirectory: 'fake-root/p',
    platformOverride: 'linux',
    managedPathOverride: null,
  })
}

function appliedTarget(sessionId: string): string {
  const merged = planMerge({}, sessionId)
  return `${JSON.stringify(merged.document, null, 2)}\n`
}

function backupKeys(files: { store: Map<string, string> }): string[] {
  return [...files.store.keys()].filter((key) => key.includes('.ocbox-backup-')).sort()
}

describe('claude-code manifest-loss durability (F8)', () => {
  it('models a target-write/manifest-loss crash window and heals it on re-setup', async () => {
    const layout = projectLayout()
    const target = targetPathForScope(layout, 'project')
    const files = memoryFiles()
    // Hard kill between the target write and the manifest write: only the
    // applied target is on disk, and no manifest exists.
    files.store.set(target, appliedTarget(SESSION_A))
    expect(files.store.has(manifestPathForTarget(target))).toBe(false)
    const before = files.store.get(target)

    const setup = await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(setup.status).toBe('already-applied')
    // Healing writes only the manifest; the target bytes are not perturbed.
    expect(files.store.get(target)).toBe(before)
    const manifestPath = manifestPathForTarget(target)
    expect(files.store.has(manifestPath)).toBe(true)
    const manifest = JSON.parse(files.store.get(manifestPath) as string) as Record<string, unknown>
    expect(manifest['adapter']).toBe('claude-code')
    expect(manifest['sessionId']).toBe(SESSION_A)
    expect(manifest['backupPath']).toBeNull()
    expect(manifest['createdFile']).toBe(true)

    const doctor = await planDoctor({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(doctor.ok).toBe(true)
    expect(doctor.findings.find((finding) => finding.check === 'manifest')?.ok).toBe(true)
  })

  it('re-setup heals a lost manifest idempotently and does not overwrite an unknown backup', async () => {
    const layout = projectLayout()
    const target = targetPathForScope(layout, 'project')
    const original = '{\n  "permissions": { "allow": ["Bash(ls)"] },\n  "keep": true\n}\n'
    const files = memoryFiles({ [target]: original })
    const first = await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(first.status).toBe('applied')
    expect(first.backupPath).not.toBeNull()
    const originalBackup = files.store.get(first.backupPath as string)
    const keysBefore = backupKeys(files)
    const appliedRaw = files.store.get(target)

    files.store.delete(manifestPathForTarget(target))
    const healed = await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(healed.status).toBe('already-applied')
    expect(healed.backupPath).toBeNull()
    // The unknown original backup is neither overwritten nor referenced.
    expect(files.store.get(first.backupPath as string)).toBe(originalBackup)
    expect(backupKeys(files)).toEqual(keysBefore)
    expect(files.store.get(target)).toBe(appliedRaw)
    const manifest = JSON.parse(files.store.get(manifestPathForTarget(target)) as string) as Record<
      string,
      unknown
    >
    expect(manifest['backupPath']).toBeNull()
    expect(manifest['createdFile']).toBe(false)
    expect(manifest['createdPointers']).toEqual(['/hooks/PreToolUse', '/hooks'])

    // A second setup sees the healed manifest and does not write again.
    const manifestBefore = files.store.get(manifestPathForTarget(target))
    const repeat = await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(repeat.status).toBe('already-applied')
    expect(files.store.get(manifestPathForTarget(target))).toBe(manifestBefore)
  })

  it('remove with no manifest deletes a fresh adapter-only target instead of leaving empty containers', async () => {
    const layout = projectLayout()
    const target = targetPathForScope(layout, 'project')
    const files = memoryFiles()
    await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    files.store.delete(manifestPathForTarget(target))
    // The crash-window state: owned containers present, manifest absent.
    expect(files.store.get(target)).toContain('PreToolUse')

    const removed = await planRemove({
      layout,
      scope: 'project',
      sessionId: null,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(removed.status).toBe('removed')
    expect(removed.conflicts).toEqual([])
    expect(files.store.has(target)).toBe(false)
    expect(files.store.has(manifestPathForTarget(target))).toBe(false)
  })

  it('remove with no manifest preserves mixed user hooks, rules, and unrelated keys', async () => {
    const layout = projectLayout()
    const target = targetPathForScope(layout, 'project')
    const userHook = { type: 'command', command: '/home/user/hook.sh' }
    const original = {
      statusLine: { type: 'command', command: 'echo hi' },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [userHook] }],
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '/home/u/post.sh' }] },
        ],
      },
      permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm -rf *)'] },
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
    files.store.delete(manifestPathForTarget(target))
    const removed = await planRemove({
      layout,
      scope: 'project',
      sessionId: null,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(removed.status).toBe('removed')
    const document = JSON.parse(files.store.get(target) as string) as ClaudeSettingsDocument
    expect(document).toEqual(original)
    const hooks = document['hooks'] as Record<string, unknown[]>
    expect(hooks['PostToolUse']).toHaveLength(1)
    expect((hooks['PreToolUse'] as Array<{ hooks: unknown[] }>)[0]?.hooks).toEqual([userHook])
    const permissions = document['permissions'] as Record<string, unknown>
    expect(permissions['allow']).toEqual(['Bash(ls)'])
    expect(permissions['deny']).toEqual(['Bash(rm -rf *)'])
  })

  it('remove with no manifest keeps a user hook co-located in the owned matcher entry', async () => {
    const layout = projectLayout()
    const target = targetPathForScope(layout, 'project')
    const userHook = { type: 'command', command: '/home/user/co-located.sh' }
    const document: ClaudeSettingsDocument = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: `ocbox agent hook claude-code --session ${SESSION_A}` },
              userHook,
            ],
          },
        ],
      },
      permissions: { allow: [OWNED_PERMISSION_ALLOW, 'Bash(ls)'] },
    }
    const files = memoryFiles({ [target]: `${JSON.stringify(document, null, 2)}\n` })
    const removed = await planRemove({
      layout,
      scope: 'project',
      sessionId: null,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(removed.status).toBe('removed')
    const result = JSON.parse(files.store.get(target) as string) as {
      hooks: { PreToolUse: Array<{ hooks: unknown[] }> }
      permissions: { allow: unknown[] }
    }
    expect(result.hooks.PreToolUse).toHaveLength(1)
    expect(result.hooks.PreToolUse[0]?.hooks).toEqual([userHook])
    expect(result.permissions.allow).toEqual(['Bash(ls)'])
  })

  it('rotates a Session with no manifest by reconstructing the base and never trusts the owned bytes', async () => {
    const layout = projectLayout()
    const target = targetPathForScope(layout, 'project')
    const original = '{\n  "permissions": { "allow": ["Bash(ls)"] },\n  "keep": true\n}\n'
    const files = memoryFiles({ [target]: original })
    const first = await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    const originalBackupRaw = files.store.get(first.backupPath as string)
    const keysBefore = backupKeys(files)
    files.store.delete(manifestPathForTarget(target))

    const rotated = await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_B,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(rotated.status).toBe('applied')
    expect(files.store.get(target)).toContain(`--session ${SESSION_B}`)
    const manifest = JSON.parse(files.store.get(manifestPathForTarget(target)) as string) as Record<
      string,
      unknown
    >
    expect(manifest['sessionId']).toBe(SESSION_B)
    expect(manifest['backupPath']).toBeNull()
    expect(manifest['createdFile']).toBe(false)
    // The real original backup survives untouched and no new one is created.
    expect(files.store.get(first.backupPath as string)).toBe(originalBackupRaw)
    expect(backupKeys(files)).toEqual(keysBefore)

    const removed = await planRemove({
      layout,
      scope: 'project',
      sessionId: null,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(removed.status).toBe('removed')
    expect(JSON.parse(files.store.get(target) as string)).toEqual(JSON.parse(original))
  })

  it('refuses unsafe byte restoration on drift without a manifest and preserves user edits', async () => {
    const layout = projectLayout()
    const target = targetPathForScope(layout, 'project')
    const original = '{\n  "permissions": { "allow": ["Bash(ls)"] },\n  "keep": true\n}\n'
    const files = memoryFiles({ [target]: original })
    await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    files.store.delete(manifestPathForTarget(target))
    const edited = JSON.parse(files.store.get(target) as string) as Record<string, unknown>
    edited['userNote'] = 'edited by hand'
    files.store.set(target, `${JSON.stringify(edited, null, 4)}\n`)

    const removed = await planRemove({
      layout,
      scope: 'project',
      sessionId: null,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(removed.status).toBe('removed')
    const restored = JSON.parse(files.store.get(target) as string) as Record<string, unknown>
    expect(restored['userNote']).toBe('edited by hand')
    expect(restored['keep']).toBe(true)
    expect(JSON.stringify(restored)).not.toContain('ocbox agent hook claude-code')
  })

  it('heals drift without clobbering the user edit and remove keeps it', async () => {
    const layout = projectLayout()
    const target = targetPathForScope(layout, 'project')
    const original = '{\n  "permissions": { "allow": ["Bash(ls)"] },\n  "keep": true\n}\n'
    const files = memoryFiles({ [target]: original })
    await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    files.store.delete(manifestPathForTarget(target))
    const edited = JSON.parse(files.store.get(target) as string) as Record<string, unknown>
    edited['userNote'] = 'edited by hand'
    const editedRaw = `${JSON.stringify(edited, null, 4)}\n`
    files.store.set(target, editedRaw)

    const healed = await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(healed.status).toBe('already-applied')
    expect(files.store.get(target)).toBe(editedRaw)
    const manifest = JSON.parse(files.store.get(manifestPathForTarget(target)) as string) as Record<
      string,
      unknown
    >
    expect(manifest['backupPath']).toBeNull()

    const removed = await planRemove({
      layout,
      scope: 'project',
      sessionId: null,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(removed.status).toBe('removed')
    const restored = JSON.parse(files.store.get(target) as string) as Record<string, unknown>
    expect(restored['userNote']).toBe('edited by hand')
    expect(restored['keep']).toBe(true)
  })

  it('keeps repeated setup/remove idempotent across a manifest loss', async () => {
    const layout = projectLayout()
    const target = targetPathForScope(layout, 'project')
    const files = memoryFiles()
    const options = {
      layout,
      scope: 'project' as const,
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    }
    expect((await planSetup(options)).status).toBe('applied')
    expect((await planSetup(options)).status).toBe('already-applied')
    files.store.delete(manifestPathForTarget(target))
    expect((await planSetup(options)).status).toBe('already-applied')
    expect((await planSetup(options)).status).toBe('already-applied')
    expect(files.store.has(manifestPathForTarget(target))).toBe(true)
    expect(
      (
        await planRemove({
          layout,
          scope: 'project',
          sessionId: null,
          claudeVersionRaw: PINNED,
          files,
        })
      ).status,
    ).toBe('removed')
    expect(files.store.has(target)).toBe(false)
    expect(
      (
        await planRemove({
          layout,
          scope: 'project',
          sessionId: null,
          claudeVersionRaw: PINNED,
          files,
        })
      ).status,
    ).toBe('not-installed')
  })

  it('preserves a pre-existing empty file when the manifest exists, and documents the no-manifest limit', async () => {
    const layout = projectLayout()
    const target = targetPathForScope(layout, 'project')
    const originalRaw = '{}\n'

    // With the manifest intact, a pre-existing empty file is restored, not deleted.
    const kept = memoryFiles({ [target]: originalRaw })
    await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files: kept,
    })
    const keptRemoved = await planRemove({
      layout,
      scope: 'project',
      sessionId: null,
      claudeVersionRaw: PINNED,
      files: kept,
    })
    expect(keptRemoved.status).toBe('removed')
    expect(kept.store.get(target)).toBe(originalRaw)

    // Documented reconstruction limit: without the manifest the adapter cannot
    // tell a fresh file from a pre-existing empty one, so an owned-only result
    // is deleted. See docs/claude-code-adapter.md.
    const lost = memoryFiles({ [target]: originalRaw })
    await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files: lost,
    })
    lost.store.delete(manifestPathForTarget(target))
    const removed = await planRemove({
      layout,
      scope: 'project',
      sessionId: null,
      claudeVersionRaw: PINNED,
      files: lost,
    })
    expect(removed.status).toBe('removed')
    expect(lost.store.has(target)).toBe(false)
  })

  it('does not take the already-applied short-circuit when the manifest is missing', async () => {
    const layout = projectLayout()
    const target = targetPathForScope(layout, 'project')
    const files = memoryFiles()
    await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    files.store.delete(manifestPathForTarget(target))
    const result = await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(result.status).toBe('already-applied')
    expect(files.store.has(manifestPathForTarget(target))).toBe(true)
    const doctor = await planDoctor({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(doctor.ok).toBe(true)
    expect(doctor.findings.some((finding) => finding.check === 'manifest' && !finding.ok)).toBe(
      false,
    )
  })
})

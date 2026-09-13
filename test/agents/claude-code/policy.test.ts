import { describe, expect, it } from 'vitest'
import { planMerge } from '../../../src/agents/claude-code/merge.js'
import {
  type PlannerFileAccess,
  planDoctor,
  planSetup,
} from '../../../src/agents/claude-code/planner.js'
import {
  OWNED_PERMISSION_ALLOW,
  parsePermissionRule,
  permissionRuleMatchesCommand,
  permissionRulesOverlap,
} from '../../../src/agents/claude-code/settings-model.js'
import {
  resolveClaudeSettingsLayout,
  targetPathForScope,
} from '../../../src/agents/claude-code/settings-sources.js'

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

function layoutFor(
  managedPathOverride: string | null = null,
  explicitPaths: readonly string[] = [],
) {
  return resolveClaudeSettingsLayout({
    homeDirectory: '/fake/home',
    projectDirectory: '/fake/proj',
    platformOverride: 'linux',
    managedPathOverride,
    explicitPaths,
  })
}

describe('claude permission matcher semantics', () => {
  it('parses bare tool, exact specifier, and colon-star prefix rules', () => {
    expect(parsePermissionRule('Bash')).toMatchObject({ tool: 'Bash', kind: 'any' })
    expect(parsePermissionRule('Bash(ocbox exec *)')).toMatchObject({
      tool: 'Bash',
      kind: 'exact',
      value: 'ocbox exec *',
    })
    expect(parsePermissionRule('Bash(ocbox exec:*)')).toMatchObject({
      tool: 'Bash',
      kind: 'prefix',
      value: 'ocbox exec',
    })
    expect(parsePermissionRule('not-a-rule(')).toBeNull()
  })

  it('matches bare tool names and colon-star prefixes against real commands', () => {
    expect(permissionRuleMatchesCommand('Bash', 'Bash', 'rm -rf /')).toBe(true)
    expect(permissionRuleMatchesCommand('Read', 'Bash', 'rm -rf /')).toBe(false)
    expect(
      permissionRuleMatchesCommand(
        'Bash(ocbox exec:*)',
        'Bash',
        'ocbox exec --session s --shell "ls"',
      ),
    ).toBe(true)
    expect(permissionRuleMatchesCommand('Bash(ocbox exec:*)', 'Bash', 'ocbox sync --all')).toBe(
      false,
    )
  })

  it('detects overlap for bare, exact, and prefix rules over the owned router', () => {
    expect(permissionRulesOverlap('Bash', OWNED_PERMISSION_ALLOW)).toBe(true)
    expect(permissionRulesOverlap('Bash(ocbox exec:*)', OWNED_PERMISSION_ALLOW)).toBe(true)
    expect(permissionRulesOverlap('Bash(ocbox exec *)', OWNED_PERMISSION_ALLOW)).toBe(true)
    expect(permissionRulesOverlap('Bash(rm -rf:*)', OWNED_PERMISSION_ALLOW)).toBe(false)
    expect(permissionRulesOverlap('Read(./secrets/**)', OWNED_PERMISSION_ALLOW)).toBe(false)
  })
})

describe('claude-code higher-policy shadowing (planMerge)', () => {
  it('protects the owned allow when a higher deny uses colon-star prefix syntax', () => {
    const merged = planMerge({}, 'sess-1', { higherDeny: ['Bash(ocbox exec:*)'] })
    expect(merged.addedPermission).toBe(false)
    expect(merged.protectedRules).toContain('Bash(ocbox exec:*)')
    expect(merged.alreadyApplied).toBe(false)
  })

  it('protects the owned allow when a higher ask rule shadows it', () => {
    const merged = planMerge({}, 'sess-1', { higherAsk: ['Bash(ocbox exec:*)'] })
    expect(merged.addedPermission).toBe(false)
    expect(merged.protectedRules).toContain('Bash(ocbox exec:*)')
  })

  it('protects the owned allow when a bare Bash rule shadows it', () => {
    const merged = planMerge({}, 'sess-1', { higherDeny: ['Bash'] })
    expect(merged.addedPermission).toBe(false)
    expect(merged.protectedRules).toContain('Bash')
  })

  it('protects the owned allow from the target document own deny/ask', () => {
    const denied = planMerge({ permissions: { deny: ['Bash(ocbox exec:*)'] } }, 'sess-1')
    expect(denied.addedPermission).toBe(false)
    expect(denied.protectedRules).toContain('Bash(ocbox exec:*)')
    const asked = planMerge({ permissions: { ask: ['Bash(ocbox exec:*)'] } }, 'sess-1')
    expect(asked.addedPermission).toBe(false)
    expect(asked.protectedRules).toContain('Bash(ocbox exec:*)')
  })

  it('still adds the owned allow when deny/ask rules are unrelated', () => {
    const merged = planMerge({}, 'sess-1', {
      higherDeny: ['Bash(rm -rf:*)'],
      higherAsk: ['Read(./secrets/**)'],
    })
    expect(merged.addedPermission).toBe(true)
    expect(merged.protectedRules).toEqual([])
  })
})

describe('claude-code scope and precedence shadowing (planSetup)', () => {
  it('refuses setup when a higher shared-project source denies the router', async () => {
    const layout = layoutFor()
    const shared = layout.sharedProjectSettingsPath
    const files = memoryFiles({ [shared]: '{"permissions":{"deny":["Bash(ocbox exec:*)"]}}' })
    await expect(
      planSetup({ layout, scope: 'user', sessionId: 's', claudeVersionRaw: PINNED, files }),
    ).rejects.toThrow(/shadow|Higher-precedence/i)
    expect(files.store.has(targetPathForScope(layout, 'user'))).toBe(false)
  })

  it('refuses setup when a higher local-project source asks about the router', async () => {
    const layout = layoutFor()
    const local = layout.localProjectSettingsPath
    const files = memoryFiles({ [local]: '{"permissions":{"ask":["Bash(ocbox exec:*)"]}}' })
    await expect(
      planSetup({ layout, scope: 'project', sessionId: 's', claudeVersionRaw: PINNED, files }),
    ).rejects.toThrow(/shadow|Higher-precedence/i)
    expect(files.store.has(targetPathForScope(layout, 'project'))).toBe(false)
  })

  it('ignores a lower shared-project deny when the target scope is local', async () => {
    const layout = layoutFor()
    const shared = layout.sharedProjectSettingsPath
    const files = memoryFiles({ [shared]: '{"permissions":{"deny":["Bash(ocbox exec:*)"]}}' })
    const setup = await planSetup({
      layout,
      scope: 'local',
      sessionId: 's',
      claudeVersionRaw: PINNED,
      files,
    })
    expect(setup.status).toBe('applied')
  })

  it('refuses setup before writing when the target scope itself carries a shadowing deny', async () => {
    const layout = layoutFor()
    const target = targetPathForScope(layout, 'project')
    const before = '{"permissions":{"deny":["Bash(ocbox exec:*)"]}}'
    const files = memoryFiles({ [target]: before })
    await expect(
      planSetup({ layout, scope: 'project', sessionId: 's', claudeVersionRaw: PINNED, files }),
    ).rejects.toThrow(/shadow|Higher-precedence/i)
    expect(files.store.get(target)).toBe(before)
  })

  it('refuses setup on higher deny and ask from an explicit read-only overlay', async () => {
    const explicitPath = '/fake/explicit.json'
    const layout = layoutFor(null, [explicitPath])
    const files = memoryFiles({
      [explicitPath]: '{"permissions":{"deny":["Bash(ocbox exec:*)"]}}',
    })
    await expect(
      planSetup({ layout, scope: 'project', sessionId: 's', claudeVersionRaw: PINNED, files }),
    ).rejects.toThrow(/shadow|Higher-precedence/i)
    expect(files.store.has(targetPathForScope(layout, 'project'))).toBe(false)
  })
})

describe('claude-code managed-lock and doctor diagnostics', () => {
  it('refuses setup when managed settings lock hooks or permission rules', async () => {
    const managed = '/fake/managed-settings.json'
    const layout = layoutFor(managed)
    const hooksLocked = memoryFiles({ [managed]: '{"allowManagedHooksOnly": true}' })
    await expect(
      planSetup({
        layout,
        scope: 'project',
        sessionId: 's',
        claudeVersionRaw: PINNED,
        files: hooksLocked,
      }),
    ).rejects.toThrow(/Managed policy/)
    const permissionsLocked = memoryFiles({
      [managed]: '{"permissions":{"allowManagedPermissionRulesOnly": true}}',
    })
    await expect(
      planSetup({
        layout,
        scope: 'project',
        sessionId: 's',
        claudeVersionRaw: PINNED,
        files: permissionsLocked,
      }),
    ).rejects.toThrow(/Managed policy/)
  })

  it('doctor exposes the identical shadow finding read-only', async () => {
    const layout = layoutFor()
    const shared = layout.sharedProjectSettingsPath
    const files = memoryFiles({ [shared]: '{"permissions":{"deny":["Bash(ocbox exec:*)"]}}' })
    const snapshot = new Map(files.store)
    const doctor = await planDoctor({
      layout,
      scope: 'user',
      sessionId: 's',
      claudeVersionRaw: PINNED,
      files,
    })
    expect(doctor.ok).toBe(false)
    const finding = doctor.findings.find((entry) => entry.check === 'higher-policy-shadow')
    expect(finding?.ok).toBe(false)
    expect(finding?.detail).toContain('Bash(ocbox exec:*)')
    expect(finding?.detail).toContain('shared-project')
    expect([...files.store.entries()]).toEqual([...snapshot.entries()])
  })

  it('doctor reports managed locks and ask shadowing with remediation', async () => {
    const managed = '/fake/managed-settings.json'
    const layout = layoutFor(managed)
    const files = memoryFiles({
      [managed]: '{"allowManagedHooksOnly": true, "permissions":{"ask":["Bash"]}}',
    })
    const doctor = await planDoctor({
      layout,
      scope: 'project',
      sessionId: 's',
      claudeVersionRaw: PINNED,
      files,
    })
    const lock = doctor.findings.find((entry) => entry.check === 'managed-lock')
    expect(lock?.ok).toBe(false)
    expect(lock?.detail).toContain('allowManagedHooksOnly')
    const shadow = doctor.findings.find((entry) => entry.check === 'higher-policy-shadow')
    expect(shadow?.ok).toBe(false)
    expect(shadow?.detail).toContain('ask')
  })

  it('doctor reports healthy higher policy when nothing shadows the router', async () => {
    const layout = layoutFor()
    const files = memoryFiles({
      [layout.userSettingsPath]: '{"permissions":{"deny":["Read(./secrets/**)"]}}',
    })
    const doctor = await planDoctor({
      layout,
      scope: 'project',
      sessionId: 's',
      claudeVersionRaw: PINNED,
      files,
    })
    expect(doctor.findings.find((entry) => entry.check === 'managed-lock')?.ok).toBe(true)
    expect(doctor.findings.find((entry) => entry.check === 'higher-policy-shadow')?.ok).toBe(true)
    expect(files.store.has(targetPathForScope(layout, 'project'))).toBe(false)
  })
})

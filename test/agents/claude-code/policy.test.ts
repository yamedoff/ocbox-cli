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
const SESSION_ID = '11111111-1111-4111-8111-111111111111'

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
      planSetup({ layout, scope: 'user', sessionId: SESSION_ID, claudeVersionRaw: PINNED, files }),
    ).rejects.toThrow(/shadow|Higher-precedence/i)
    expect(files.store.has(targetPathForScope(layout, 'user'))).toBe(false)
  })

  it('refuses setup when a higher local-project source asks about the router', async () => {
    const layout = layoutFor()
    const local = layout.localProjectSettingsPath
    const files = memoryFiles({ [local]: '{"permissions":{"ask":["Bash(ocbox exec:*)"]}}' })
    await expect(
      planSetup({
        layout,
        scope: 'project',
        sessionId: SESSION_ID,
        claudeVersionRaw: PINNED,
        files,
      }),
    ).rejects.toThrow(/shadow|Higher-precedence/i)
    expect(files.store.has(targetPathForScope(layout, 'project'))).toBe(false)
  })

  it('refuses setup when a lower shared-project source denies the router locally (N1)', async () => {
    const layout = layoutFor()
    const shared = layout.sharedProjectSettingsPath
    const files = memoryFiles({ [shared]: '{"permissions":{"deny":["Bash(ocbox exec:*)"]}}' })
    await expect(
      planSetup({ layout, scope: 'local', sessionId: SESSION_ID, claudeVersionRaw: PINNED, files }),
    ).rejects.toThrow(/shadow/i)
    expect(files.store.has(targetPathForScope(layout, 'local'))).toBe(false)
  })

  it('refuses setup before writing when the target scope itself carries a shadowing deny', async () => {
    const layout = layoutFor()
    const target = targetPathForScope(layout, 'project')
    const before = '{"permissions":{"deny":["Bash(ocbox exec:*)"]}}'
    const files = memoryFiles({ [target]: before })
    await expect(
      planSetup({
        layout,
        scope: 'project',
        sessionId: SESSION_ID,
        claudeVersionRaw: PINNED,
        files,
      }),
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
      planSetup({
        layout,
        scope: 'project',
        sessionId: SESSION_ID,
        claudeVersionRaw: PINNED,
        files,
      }),
    ).rejects.toThrow(/shadow|Higher-precedence/i)
    expect(files.store.has(targetPathForScope(layout, 'project'))).toBe(false)
  })
})

interface LowerPolicyCase {
  readonly label: string
  readonly scope: 'project' | 'local'
  readonly source: 'user' | 'shared-project'
  readonly polarity: 'deny' | 'ask'
  readonly rule: string
}

describe('claude-code unioned deny/ask from lower-precedence sources (N1)', () => {
  const cases: readonly LowerPolicyCase[] = [
    {
      label: 'project target + user deny colon-star',
      scope: 'project',
      source: 'user',
      polarity: 'deny',
      rule: OWNED_PERMISSION_ALLOW,
    },
    {
      label: 'project target + user ask colon-star',
      scope: 'project',
      source: 'user',
      polarity: 'ask',
      rule: OWNED_PERMISSION_ALLOW,
    },
    {
      label: 'project target + user deny bare Bash',
      scope: 'project',
      source: 'user',
      polarity: 'deny',
      rule: 'Bash',
    },
    {
      label: 'project target + user ask bare Bash',
      scope: 'project',
      source: 'user',
      polarity: 'ask',
      rule: 'Bash',
    },
    {
      label: 'project target + user deny exact subcommand',
      scope: 'project',
      source: 'user',
      polarity: 'deny',
      rule: 'Bash(ocbox exec --session s1 --shell ls)',
    },
    {
      label: 'project target + user deny exact owned stub',
      scope: 'project',
      source: 'user',
      polarity: 'deny',
      rule: 'Bash(ocbox exec)',
    },
    {
      label: 'local target + shared-project deny colon-star',
      scope: 'local',
      source: 'shared-project',
      polarity: 'deny',
      rule: OWNED_PERMISSION_ALLOW,
    },
    {
      label: 'local target + shared-project ask bare Bash',
      scope: 'local',
      source: 'shared-project',
      polarity: 'ask',
      rule: 'Bash',
    },
    {
      label: 'local target + shared-project deny exact subcommand',
      scope: 'local',
      source: 'shared-project',
      polarity: 'deny',
      rule: 'Bash(ocbox exec --session s1 --shell ls)',
    },
    {
      label: 'local target + user deny colon-star',
      scope: 'local',
      source: 'user',
      polarity: 'deny',
      rule: OWNED_PERMISSION_ALLOW,
    },
    {
      label: 'local target + user ask bare Bash',
      scope: 'local',
      source: 'user',
      polarity: 'ask',
      rule: 'Bash',
    },
  ]

  it.each(cases)('$label refuses setup before writing the target', async (testCase) => {
    const layout = layoutFor()
    const sourcePath =
      testCase.source === 'user' ? layout.userSettingsPath : layout.sharedProjectSettingsPath
    const target = targetPathForScope(layout, testCase.scope)
    const before = '{"permissions":{"allow":["Bash(npm test:*)"]}}'
    const files = memoryFiles({
      [sourcePath]: JSON.stringify({ permissions: { [testCase.polarity]: [testCase.rule] } }),
      [target]: before,
    })
    await expect(
      planSetup({
        layout,
        scope: testCase.scope,
        sessionId: SESSION_ID,
        claudeVersionRaw: PINNED,
        files,
      }),
    ).rejects.toThrow(/shadows the owned router/i)
    expect(files.store.get(target)).toBe(before)
  })

  it('still applies when a lower deny is unrelated to the owned router', async () => {
    const layout = layoutFor()
    const files = memoryFiles({
      [layout.userSettingsPath]: '{"permissions":{"deny":["Read(./secrets/**)"]}}',
    })
    const setup = await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_ID,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(setup.status).toBe('applied')
  })

  it('keeps managed locks scoped to at-or-above sources (lower user lock does not block)', async () => {
    const layout = layoutFor()
    const projectTarget = targetPathForScope(layout, 'project')
    const userLocked = memoryFiles({
      [layout.userSettingsPath]: '{"allowManagedHooksOnly": true}',
    })
    const setup = await planSetup({
      layout,
      scope: 'project',
      sessionId: SESSION_ID,
      claudeVersionRaw: PINNED,
      files: userLocked,
    })
    expect(setup.status).toBe('applied')
    expect(userLocked.store.has(projectTarget)).toBe(true)
  })

  it('doctor reports a lower user deny as a blocker', async () => {
    const layout = layoutFor()
    const files = memoryFiles({
      [layout.userSettingsPath]: '{"permissions":{"deny":["Bash(ocbox exec:*)"]}}',
    })
    const doctor = await planDoctor({
      layout,
      scope: 'project',
      sessionId: SESSION_ID,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(doctor.ok).toBe(false)
    const shadow = doctor.findings.find((entry) => entry.check === 'higher-policy-shadow')
    expect(shadow?.ok).toBe(false)
    expect(shadow?.detail).toContain('Bash(ocbox exec:*)')
    expect(shadow?.detail).toContain('user')
  })

  it('doctor reports a lower shared-project ask as a blocker for local scope', async () => {
    const layout = layoutFor()
    const files = memoryFiles({
      [layout.sharedProjectSettingsPath]: '{"permissions":{"ask":["Bash"]}}',
    })
    const doctor = await planDoctor({
      layout,
      scope: 'local',
      sessionId: SESSION_ID,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(doctor.ok).toBe(false)
    const shadow = doctor.findings.find((entry) => entry.check === 'higher-policy-shadow')
    expect(shadow?.ok).toBe(false)
    expect(shadow?.detail).toContain('shared-project')
    expect(shadow?.detail).toContain('ask')
  })

  it('session validation runs before policy evaluation (invalid id fails even under a shadow)', async () => {
    const layout = layoutFor()
    const files = memoryFiles({
      [layout.userSettingsPath]: '{"permissions":{"deny":["Bash(ocbox exec:*)"]}}',
    })
    await expect(
      planSetup({
        layout,
        scope: 'project',
        sessionId: 'sess-1',
        claudeVersionRaw: PINNED,
        files,
      }),
    ).rejects.toThrow(/not a valid Session ID/)
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
        sessionId: SESSION_ID,
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
        sessionId: SESSION_ID,
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
      sessionId: SESSION_ID,
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
      sessionId: SESSION_ID,
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
      sessionId: SESSION_ID,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(doctor.findings.find((entry) => entry.check === 'managed-lock')?.ok).toBe(true)
    expect(doctor.findings.find((entry) => entry.check === 'higher-policy-shadow')?.ok).toBe(true)
    expect(files.store.has(targetPathForScope(layout, 'project'))).toBe(false)
  })
})

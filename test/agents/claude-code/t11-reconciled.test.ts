import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HOOK_DENY_SOURCE_GUARD,
  HOOK_DENY_SOURCE_ROUTE,
  runClaudeRoutingHook,
} from '../../../src/agents/claude-code/hook.js'
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
import { manifestPathForTarget } from '../../../src/agents/claude-code/store.js'

const PINNED = '2.0.51 (Claude Code)'
const SESSION_A = '11111111-1111-4111-8111-111111111111'

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
    platformOverride: 'linux',
    managedPathOverride: null,
  })
}

function hookPayload(command: string): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  })
}

describe('t11 reconciled F1-F6 semantics', () => {
  it('padded session installs canonical hook and remove restores exact original bytes', async () => {
    const layout = projectLayout('fake-root')
    const target = targetPathForScope(layout, 'project')
    const original =
      '{\r\n    "permissions": {\r\n        "allow": [\r\n            "Bash(ls)"\r\n        ]\r\n    }\r\n}'
    const files = memoryFiles({ [target]: original })
    const setup = await planSetup({
      layout,
      scope: 'project',
      sessionId: `  ${SESSION_A} `,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(setup.status).toBe('applied')
    expect(setup.sessionId).toBe(SESSION_A)
    const installed = files.store.get(target) as string
    expect(installed).toContain(`--session ${SESSION_A}`)
    const manifest = JSON.parse(files.store.get(manifestPathForTarget(target)) as string) as Record<
      string,
      unknown
    >
    expect(manifest['sessionId']).toBe(SESSION_A)
    const removed = await planRemove({
      layout,
      scope: 'project',
      sessionId: null,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(removed.status).toBe('removed')
    expect(files.store.get(target)).toBe(original)
  })

  it('invalid policy source fails setup closed with no writes and doctor reports policy-sources', async () => {
    const layout = resolveClaudeSettingsLayout({
      homeDirectory: '/fake/home',
      projectDirectory: '/fake/proj',
      platformOverride: 'linux',
      managedPathOverride: '/fake/managed.json',
    })
    const target = targetPathForScope(layout, 'project')
    const files = memoryFiles({
      '/fake/managed.json':
        '{"permissions":{"deny":["Bash(ocbox exec:*)"],"allow":"not-an-array"}}',
    })
    await expect(
      planSetup({
        layout,
        scope: 'project',
        sessionId: SESSION_A,
        claudeVersionRaw: PINNED,
        files,
      }),
    ).rejects.toThrow(/policy sources could not be read or validated/i)
    expect(files.store.has(target)).toBe(false)
    expect(files.store.has(manifestPathForTarget(target))).toBe(false)
    const doctor = await planDoctor({
      layout,
      scope: 'project',
      sessionId: SESSION_A,
      claudeVersionRaw: PINNED,
      files,
    })
    expect(doctor.ok).toBe(false)
    expect(
      doctor.findings.some((finding) => finding.check === 'policy-sources' && !finding.ok),
    ).toBe(true)
  })

  it('routed remote outcome denies the local copy with a route reason distinct from the guard', async () => {
    const decisions: Array<{ permissionDecisionReason: string }> = []
    const errors: string[] = []
    const exitCode = await runClaudeRoutingHook({
      rawInput: hookPayload('echo hi'),
      sessionId: SESSION_A,
      environment: {},
      invokeExec: async () => ({ started: true, exitCode: 0, outcome: 'remote_result' }),
      writeError: (message) => {
        errors.push(message)
      },
      writeDecision: (decision) => {
        decisions.push({
          permissionDecisionReason: decision.hookSpecificOutput.permissionDecisionReason,
        })
      },
    })
    expect(exitCode).toBe(2)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.permissionDecisionReason).toContain(
      `ocbox-block[${HOOK_DENY_SOURCE_ROUTE}]`,
    )
    expect(decisions[0]?.permissionDecisionReason).toContain('exit-code=0')
    const guardDecisions: Array<{ permissionDecisionReason: string }> = []
    const guardExit = await runClaudeRoutingHook({
      rawInput: 'not-json',
      sessionId: SESSION_A,
      environment: {},
      invokeExec: async () => ({ started: true, exitCode: 0, outcome: 'remote_result' }),
      writeError: () => {},
      writeDecision: (decision) => {
        guardDecisions.push({
          permissionDecisionReason: decision.hookSpecificOutput.permissionDecisionReason,
        })
      },
    })
    expect(guardExit).toBe(2)
    expect(guardDecisions).toHaveLength(1)
    expect(guardDecisions[0]?.permissionDecisionReason).toContain(
      `ocbox-block[${HOOK_DENY_SOURCE_GUARD}]`,
    )
    expect(errors.join('\n')).toContain(`ocbox-block[${HOOK_DENY_SOURCE_ROUTE}]`)
  })
})

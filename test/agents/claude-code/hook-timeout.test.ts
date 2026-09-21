import { describe, expect, it } from 'vitest'
import {
  type ClaudeHookDenyDecision,
  type ClaudeHookExecResult,
  type ClaudeHookOutcome,
  runClaudeRoutingHook,
} from '../../../src/agents/claude-code/hook.js'
import { planMerge } from '../../../src/agents/claude-code/merge.js'
import {
  ADAPTER_ID_ENV,
  buildHookCommand,
  RECURSION_GUARD_ENV,
  recursionGuardArgs,
} from '../../../src/agents/claude-code/routing.js'
import {
  assertClaudeHookTimeoutOrdering,
  CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS,
  CLAUDE_CODE_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS,
  CLAUDE_CODE_HOOK_TIMEOUT_SECONDS,
  MILLISECONDS_PER_SECOND,
} from '../../../src/agents/claude-code/timeouts.js'
import { OWNED_PERMISSION_ALLOW } from '../../../src/agents/claude-code/settings-model.js'

const SESSION = '11111111-1111-4111-8111-111111111111'

function payload(command: string, toolName = 'Bash'): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { command },
  })
}

function ownedHook(document: unknown): {
  readonly type?: unknown
  readonly command?: unknown
  readonly timeout?: unknown
} {
  const hooks = (document as { hooks?: { PreToolUse?: unknown[] } }).hooks
  const entries = hooks?.PreToolUse ?? []
  const entry = entries[0] as { hooks?: unknown[] } | undefined
  return (entry?.hooks?.[0] ?? {}) as {
    readonly type?: unknown
    readonly command?: unknown
    readonly timeout?: unknown
  }
}

interface HookHarness {
  readonly rawInput?: string
  readonly sessionId?: string | null
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly result?: ClaudeHookExecResult
}

async function runHook(overrides: HookHarness = {}): Promise<{
  readonly exitCode: number
  readonly calls: string[][]
  readonly decisions: ClaudeHookDenyDecision[]
}> {
  const calls: string[][] = []
  const decisions: ClaudeHookDenyDecision[] = []
  const exitCode = await runClaudeRoutingHook({
    rawInput: overrides.rawInput ?? payload('npm test'),
    sessionId: overrides.sessionId === undefined ? SESSION : overrides.sessionId,
    environment: overrides.environment ?? {},
    invokeExec: async (argv) => {
      calls.push([...argv])
      return overrides.result ?? { started: true, exitCode: 0, outcome: 'remote_result' }
    },
    writeError: () => undefined,
    writeDecision: (decision) => {
      decisions.push(decision)
    },
  })
  return { exitCode, calls, decisions }
}

function routeReason(decisions: readonly ClaudeHookDenyDecision[]): string {
  expect(decisions).toHaveLength(1)
  return decisions[0]?.hookSpecificOutput.permissionDecisionReason ?? ''
}

describe('claude-code PreToolUse hook timeout contract (F7)', () => {
  it('orders the remote execution timeout strictly inside the hook deadline', () => {
    const hookDeadlineMilliseconds = CLAUDE_CODE_HOOK_TIMEOUT_SECONDS * MILLISECONDS_PER_SECOND
    expect(CLAUDE_CODE_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS).toBeGreaterThan(0)
    expect(CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS).toBeGreaterThan(0)
    expect(CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS).toBeLessThan(hookDeadlineMilliseconds)
    expect(hookDeadlineMilliseconds - CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS).toBe(
      CLAUDE_CODE_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS,
    )
    expect(() => assertClaudeHookTimeoutOrdering()).not.toThrow()
  })

  it('emits an explicit supported hook timeout on the installed command handler', () => {
    const merged = planMerge({}, SESSION)
    const hook = ownedHook(merged.document)
    expect(hook.type).toBe('command')
    expect(hook.command).toBe(buildHookCommand(SESSION))
    expect(hook.timeout).toBe(CLAUDE_CODE_HOOK_TIMEOUT_SECONDS)
    // The same shape is reused on a Session rotation, preserving the timeout.
    const rotated = planMerge(merged.document, '22222222-2222-4222-8222-222222222222')
    expect(ownedHook(rotated.document).timeout).toBe(CLAUDE_CODE_HOOK_TIMEOUT_SECONDS)
  })

  it('reconciles the explicit timeout onto an owned hook installed before F7', () => {
    const document = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: buildHookCommand(SESSION) }],
          },
        ],
      },
      permissions: { allow: [OWNED_PERMISSION_ALLOW] },
    }
    const merged = planMerge(document, SESSION)
    expect(merged.ownedHookPresent).toBe(true)
    expect(merged.reconciledHookTimeout).toBe(true)
    expect(merged.changed).toBe(true)
    expect(merged.alreadyApplied).toBe(false)
    expect(ownedHook(merged.document).timeout).toBe(CLAUDE_CODE_HOOK_TIMEOUT_SECONDS)
    const healed = planMerge(merged.document, SESSION)
    expect(healed.reconciledHookTimeout).toBe(false)
    expect(healed.alreadyApplied).toBe(true)
  })

  it('passes the bounded remote timeout (milliseconds) in the exec argv', async () => {
    const { calls, exitCode } = await runHook()
    expect(exitCode).toBe(2)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([
      'exec',
      '--session',
      SESSION,
      '--timeout',
      String(CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS),
      '--shell',
      'npm test',
      ...recursionGuardArgs(),
    ])
    expect(calls[0]?.slice(-4)).toEqual([...recursionGuardArgs()])
    expect(calls[0]).toContain(`${RECURSION_GUARD_ENV}=1`)
    expect(calls[0]).toContain(`${ADAPTER_ID_ENV}=claude-code`)
  })

  it('maps every started remote outcome to the blocking route denial before the deadline', async () => {
    const outcomes: ReadonlyArray<readonly [ClaudeHookOutcome, number]> = [
      ['remote_result', 0],
      ['timeout', 124],
      ['cancelled', 130],
      ['infrastructure_error', 125],
    ]
    for (const [outcome, exitCode] of outcomes) {
      const {
        exitCode: hookExit,
        calls,
        decisions,
      } = await runHook({
        result: { started: true, exitCode, outcome },
      })
      expect(hookExit).toBe(2)
      expect(calls).toHaveLength(1)
      const reason = routeReason(decisions)
      expect(reason).toContain('ocbox-block[route]')
      expect(reason).toContain(`outcome=${outcome}`)
      expect(reason).toContain(`exit-code=${exitCode}`)
      expect(reason).toContain('does not run twice')
    }
  })

  it('never falls back to local execution for a started run, timeout, cancel, or error', async () => {
    for (const outcome of [
      'remote_result',
      'timeout',
      'cancelled',
      'infrastructure_error',
    ] as const) {
      const { exitCode, calls, decisions } = await runHook({
        result: { started: true, exitCode: 1, outcome },
      })
      expect(exitCode).toBe(2)
      expect(calls).toHaveLength(1)
      expect(routeReason(decisions)).toContain('ocbox-block[route]')
    }
    const preStart = await runHook({
      result: { started: false, exitCode: 125, outcome: 'infrastructure_error' },
    })
    expect(preStart.exitCode).toBe(2)
    expect(preStart.calls).toHaveLength(1)
    expect(routeReason(preStart.decisions)).toContain('ocbox-block[guard]')
  })

  it('leaves only uncovered or recursion-guarded calls local with exit 0', async () => {
    const uncovered = await runHook({ rawInput: payload('echo hi', 'Edit') })
    expect(uncovered.exitCode).toBe(0)
    expect(uncovered.calls).toHaveLength(0)
    expect(uncovered.decisions).toHaveLength(0)
    const guarded = await runHook({
      environment: { [RECURSION_GUARD_ENV]: '1', [ADAPTER_ID_ENV]: 'claude-code' },
    })
    expect(guarded.exitCode).toBe(0)
    expect(guarded.calls).toHaveLength(0)
    expect(guarded.decisions).toHaveLength(0)
  })
})

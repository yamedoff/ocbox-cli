import { describe, expect, it } from 'vitest'
import {
  type ClaudeHookDenyDecision,
  type ClaudeHookExecResult,
  guardDenyReason,
  parseClaudeHookInput,
  routeDenyReason,
  runClaudeRoutingHook,
} from '../../../src/agents/claude-code/hook.js'
import {
  ADAPTER_ID_ENV,
  buildHookCommand,
  RECURSION_GUARD_ENV,
  recursionGuardArgs,
} from '../../../src/agents/claude-code/routing.js'
import { CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS } from '../../../src/agents/claude-code/timeouts.js'
import {
  isOwnedHookCommand,
  OWNED_HOOK_COMMAND_FRAGMENT,
  OWNED_PERMISSION_ALLOW,
  permissionRuleOwned,
} from '../../../src/agents/claude-code/settings-model.js'

function claudePayload(command: string, toolName = 'Bash'): string {
  return JSON.stringify({
    session_id: 'claude-session',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/workspace',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { command },
  })
}

function sessionFromHookCommand(command: string): string | null {
  const match = /(?:^|\s)--session\s+(\S+)/.exec(command)
  return match?.[1] ?? null
}

const REMOTE_SUCCESS: ClaudeHookExecResult = {
  started: true,
  exitCode: 0,
  outcome: 'remote_result',
}

interface HookHarness {
  readonly rawInput?: string
  readonly sessionId?: string | null
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly result?: ClaudeHookExecResult
  readonly throwError?: Error
}

async function runHook(overrides: HookHarness = {}): Promise<{
  readonly exitCode: number
  readonly calls: string[][]
  readonly errors: string[]
  readonly decisions: ClaudeHookDenyDecision[]
}> {
  const calls: string[][] = []
  const errors: string[] = []
  const decisions: ClaudeHookDenyDecision[] = []
  const exitCode = await runClaudeRoutingHook({
    rawInput: overrides.rawInput ?? claudePayload('npm test'),
    sessionId: overrides.sessionId === undefined ? 'sess-1' : overrides.sessionId,
    environment: overrides.environment ?? {},
    invokeExec: async (argv) => {
      calls.push([...argv])
      if (overrides.throwError !== undefined) throw overrides.throwError
      return overrides.result ?? REMOTE_SUCCESS
    },
    writeError: (message) => {
      errors.push(message)
    },
    writeDecision: (decision) => {
      decisions.push(decision)
    },
  })
  return { exitCode, calls, errors, decisions }
}

function onlyDecision(decisions: readonly ClaudeHookDenyDecision[]): ClaudeHookDenyDecision {
  expect(decisions).toHaveLength(1)
  const decision = decisions[0]
  if (decision === undefined) throw new Error('expected a hook decision')
  return decision
}

describe('claude-code hook entrypoint', () => {
  it('reads the documented Claude Code stdin JSON contract', () => {
    expect(parseClaudeHookInput(claudePayload('npm test'))).toEqual({
      toolName: 'Bash',
      command: 'npm test',
    })
    expect(parseClaudeHookInput('not json')).toBeNull()
    expect(parseClaudeHookInput('[]')).toBeNull()
    expect(parseClaudeHookInput('{"tool_name":"Bash"}')).toBeNull()
    expect(parseClaudeHookInput('{"tool_name":"Bash","tool_input":{}}')).toBeNull()
    expect(parseClaudeHookInput('{"tool_input":{"command":"x"}}')).toBeNull()
  })

  it('routes a covered Bash call through ocbox exec and denies the local copy', async () => {
    const hookCommand = buildHookCommand('sess-1')
    expect(hookCommand).toBe('ocbox agent hook claude-code --session sess-1')
    expect(isOwnedHookCommand(hookCommand)).toBe(true)
    const sessionId = sessionFromHookCommand(hookCommand)
    expect(sessionId).toBe('sess-1')

    const routed = await runHook({ sessionId })
    // Exit 2 is the documented PreToolUse block: the local Bash tool call is denied.
    expect(routed.exitCode).toBe(2)
    expect(routed.calls).toEqual([
      [
        'exec',
        '--session',
        'sess-1',
        '--timeout',
        String(CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS),
        '--shell',
        'npm test',
        '--env',
        `${RECURSION_GUARD_ENV}=1`,
        '--env',
        `${ADAPTER_ID_ENV}=claude-code`,
      ],
    ])
    expect(recursionGuardArgs()).toEqual(routed.calls[0]?.slice(-4))
    const decision = onlyDecision(routed.decisions)
    expect(decision.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('ocbox-block[route]')
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('exit-code=0')
  })

  it('reports a successful remote run exactly once so there is no duplicate local path', async () => {
    const { exitCode, calls, decisions } = await runHook()
    expect(exitCode).toBe(2)
    expect(calls).toHaveLength(1)
    const decision = onlyDecision(decisions)
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('outcome=remote_result')
  })

  it('denies the local copy for every honest remote exit (1, 2, 125)', async () => {
    for (const exitCode of [1, 2, 125]) {
      const result: ClaudeHookExecResult = { started: true, exitCode, outcome: 'remote_result' }
      const { exitCode: hookExit, calls, decisions } = await runHook({ result })
      expect(hookExit).toBe(2)
      expect(calls).toHaveLength(1)
      const reason = onlyDecision(decisions).hookSpecificOutput.permissionDecisionReason
      expect(reason).toContain('ocbox-block[route]')
      expect(reason).toContain(`exit-code=${exitCode}`)
    }
  })

  it('distinguishes a legitimate remote exit 2 from the adapter guard in machine-readable output', async () => {
    const remoteTwo: ClaudeHookExecResult = {
      started: true,
      exitCode: 2,
      outcome: 'remote_result',
    }
    const routed = await runHook({ result: remoteTwo })
    const routedReason = onlyDecision(routed.decisions).hookSpecificOutput.permissionDecisionReason
    expect(routedReason.startsWith(`ocbox-block[route]`)).toBe(true)
    expect(routedReason).toContain('exit-code=2')

    const guarded = await runHook({ sessionId: null })
    const guardedReason = onlyDecision(guarded.decisions).hookSpecificOutput
      .permissionDecisionReason
    expect(guardedReason.startsWith(`ocbox-block[guard]`)).toBe(true)
    expect(guardedReason).not.toContain('exit-code=2')

    expect(guardDenyReason('x')).not.toBe(routeDenyReason(remoteTwo))
    expect(routeDenyReason(remoteTwo)).not.toContain('guard')
  })

  it('denies the local copy after a post-start provider/infrastructure failure (F6)', async () => {
    const failure: ClaudeHookExecResult = {
      started: true,
      exitCode: 125,
      outcome: 'infrastructure_error',
    }
    const { exitCode, calls, decisions } = await runHook({ result: failure })
    expect(exitCode).toBe(2)
    expect(calls).toHaveLength(1)
    const reason = onlyDecision(decisions).hookSpecificOutput.permissionDecisionReason
    expect(reason).toContain('ocbox-block[route]')
    expect(reason).toContain('outcome=infrastructure_error')
    expect(reason).toContain('exit-code=125')
  })

  it('fails closed with a guard denial on an unreadable hook payload', async () => {
    const { exitCode, calls, errors, decisions } = await runHook({ rawInput: '{oops' })
    expect(exitCode).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errors[0]).toContain('failing closed')
    expect(onlyDecision(decisions).hookSpecificOutput.permissionDecisionReason).toContain(
      'ocbox-block[guard]',
    )
  })

  it('fails closed with a guard denial on a covered Bash call without a session', async () => {
    const sessionless = buildHookCommand(null)
    expect(sessionless).toBe(OWNED_HOOK_COMMAND_FRAGMENT)
    expect(sessionFromHookCommand(sessionless)).toBeNull()

    const { exitCode, calls, errors, decisions } = await runHook({ sessionId: null })
    expect(exitCode).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errors[0]).toContain('failing closed')
    expect(onlyDecision(decisions).hookSpecificOutput.permissionDecisionReason).toContain(
      'ocbox-block[guard]',
    )
  })

  it('fails closed when the routed invocation cannot start', async () => {
    const preStart: ClaudeHookExecResult = {
      started: false,
      exitCode: 125,
      outcome: 'infrastructure_error',
    }
    const { exitCode, decisions } = await runHook({ result: preStart })
    expect(exitCode).toBe(2)
    const reason = onlyDecision(decisions).hookSpecificOutput.permissionDecisionReason
    expect(reason).toContain('ocbox-block[guard]')
    expect(reason).toContain('exit-code=125')
  })

  it('fails closed when the invoked exec unexpectedly rejects', async () => {
    const { exitCode, decisions } = await runHook({
      throwError: new Error('unexpected transport crash'),
    })
    expect(exitCode).toBe(2)
    expect(onlyDecision(decisions).hookSpecificOutput.permissionDecisionReason).toContain(
      'ocbox-block[guard]',
    )
  })

  it('checks and sets the recursion markers so nested routing cannot loop', async () => {
    const guarded = await runHook({
      environment: { [RECURSION_GUARD_ENV]: '1', [ADAPTER_ID_ENV]: 'claude-code' },
    })
    expect(guarded.exitCode).toBe(0)
    expect(guarded.calls).toHaveLength(0)
    expect(guarded.decisions).toHaveLength(0)

    const routed = await runHook()
    const argv = routed.calls[0] ?? []
    expect(argv).toContain(`${RECURSION_GUARD_ENV}=1`)
    expect(argv).toContain(`${ADAPTER_ID_ENV}=claude-code`)
  })

  it('leaves uncovered tools and owned invocations local with exit 0 and no decision', async () => {
    const edit = await runHook({ rawInput: claudePayload('npm test', 'Edit') })
    expect(edit.exitCode).toBe(0)
    expect(edit.calls).toHaveLength(0)
    expect(edit.decisions).toHaveLength(0)

    const nested = await runHook({
      rawInput: claudePayload('ocbox agent hook claude-code --session other'),
    })
    expect(nested.exitCode).toBe(0)
    expect(nested.calls).toHaveLength(0)
    expect(nested.decisions).toHaveLength(0)
  })

  it('uses the pinned colon-star Bash matcher form for owned rules', () => {
    expect(OWNED_PERMISSION_ALLOW).toBe('Bash(ocbox exec:*)')
    expect(permissionRuleOwned('Bash(ocbox exec:*)')).toBe(true)
    expect(permissionRuleOwned('Bash(ocbox exec *)')).toBe(false)
    expect(OWNED_HOOK_COMMAND_FRAGMENT).toBe('ocbox agent hook claude-code')
    expect(isOwnedHookCommand(buildHookCommand('s'))).toBe(true)
    expect(isOwnedHookCommand('Bash(ocbox exec:*)')).toBe(false)
    expect(isOwnedHookCommand('node ./unrelated-hook.js')).toBe(false)
  })
})

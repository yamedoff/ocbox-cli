import { describe, expect, it } from 'vitest'
import {
  type ClaudeRoutingHookOptions,
  parseClaudeHookInput,
  runClaudeRoutingHook,
} from '../../../src/agents/claude-code/hook.js'
import {
  ADAPTER_ID_ENV,
  buildHookCommand,
  RECURSION_GUARD_ENV,
  recursionGuardArgs,
} from '../../../src/agents/claude-code/routing.js'
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

async function runHook(overrides: Partial<ClaudeRoutingHookOptions> = {}): Promise<{
  readonly exitCode: number
  readonly calls: string[][]
  readonly errors: string[]
}> {
  const calls: string[][] = []
  const errors: string[] = []
  const exitCode = await runClaudeRoutingHook({
    rawInput: claudePayload('npm test'),
    sessionId: 'sess-1',
    environment: {},
    invokeExec: async (argv) => {
      calls.push([...argv])
      return 0
    },
    writeError: (message) => {
      errors.push(message)
    },
    ...overrides,
  })
  return { exitCode, calls, errors }
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

  it('executes the emitted hook command for a covered Bash call', async () => {
    const hookCommand = buildHookCommand('sess-1')
    expect(hookCommand).toBe('ocbox agent hook claude-code --session sess-1')
    expect(isOwnedHookCommand(hookCommand)).toBe(true)
    const sessionId = sessionFromHookCommand(hookCommand)
    expect(sessionId).toBe('sess-1')

    const routed = await runHook({ sessionId })
    expect(routed.exitCode).toBe(0)
    expect(routed.errors).toEqual([])
    expect(routed.calls).toEqual([
      [
        'exec',
        '--session',
        'sess-1',
        '--shell',
        'npm test',
        '--env',
        `${RECURSION_GUARD_ENV}=1`,
        '--env',
        `${ADAPTER_ID_ENV}=claude-code`,
      ],
    ])
    expect(recursionGuardArgs()).toEqual(routed.calls[0]?.slice(-4))
  })

  it('fails closed with exit 2 on an unreadable hook payload', async () => {
    const { exitCode, calls, errors } = await runHook({ rawInput: '{oops' })
    expect(exitCode).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errors[0]).toContain('failing closed')
  })

  it('fails closed with exit 2 on a covered Bash call without a session', async () => {
    const sessionless = buildHookCommand(null)
    expect(sessionless).toBe(OWNED_HOOK_COMMAND_FRAGMENT)
    expect(sessionFromHookCommand(sessionless)).toBeNull()

    const { exitCode, calls, errors } = await runHook({ sessionId: null })
    expect(exitCode).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errors[0]).toContain('failing closed')
  })

  it('checks and sets the recursion markers so nested routing cannot loop', async () => {
    const guarded = await runHook({
      environment: { [RECURSION_GUARD_ENV]: '1', [ADAPTER_ID_ENV]: 'claude-code' },
    })
    expect(guarded.exitCode).toBe(0)
    expect(guarded.calls).toHaveLength(0)

    const routed = await runHook()
    const argv = routed.calls[0] ?? []
    expect(argv).toContain(`${RECURSION_GUARD_ENV}=1`)
    expect(argv).toContain(`${ADAPTER_ID_ENV}=claude-code`)
  })

  it('leaves uncovered tools and owned invocations local with exit 0', async () => {
    const edit = await runHook({ rawInput: claudePayload('npm test', 'Edit') })
    expect(edit.exitCode).toBe(0)
    expect(edit.calls).toHaveLength(0)

    const nested = await runHook({
      rawInput: claudePayload('ocbox agent hook claude-code --session other'),
    })
    expect(nested.exitCode).toBe(0)
    expect(nested.calls).toHaveLength(0)
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

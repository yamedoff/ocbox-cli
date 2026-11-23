import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_MATRIX,
  HOOK_EVENTS,
  HOOKABLE_TOOL_NAMES,
  PINNED_SURFACE_SUMMARY,
  ROUTING_AID_NOTICE,
} from '../../../src/agents/claude-code/capabilities.js'
import {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_TOOL_MATCHERS,
} from '../../../src/agents/claude-code/version.js'
import {
  buildHookCommand,
  decideRouting,
  parseOwnedHookCommand,
} from '../../../src/agents/claude-code/routing.js'
import {
  CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS,
  CLAUDE_CODE_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS,
  CLAUDE_CODE_HOOK_TIMEOUT_SECONDS,
  MILLISECONDS_PER_SECOND,
} from '../../../src/agents/claude-code/timeouts.js'
import { OWNED_HOOK_COMMAND_FRAGMENT } from '../../../src/agents/claude-code/settings-model.js'

describe('claude-code routing and capability matrix', () => {
  it('routes covered Bash through ocbox exec bounded below the hook deadline (F7)', () => {
    const decision = decideRouting({
      toolName: 'Bash',
      command: 'npm test',
      sessionId: 'sess-9',
      environment: {},
    })
    expect(decision.action).toBe('route')
    expect(decision.execArgv).toEqual([
      'exec',
      '--session',
      'sess-9',
      '--timeout',
      String(CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS),
      '--shell',
      'npm test',
    ])
  })

  it('orders the remote timeout strictly inside the emitted hook deadline (F7)', () => {
    const hookDeadlineMilliseconds = CLAUDE_CODE_HOOK_TIMEOUT_SECONDS * MILLISECONDS_PER_SECOND
    expect(CLAUDE_CODE_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS).toBeGreaterThan(0)
    expect(CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS).toBeGreaterThan(0)
    expect(CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS).toBeLessThan(hookDeadlineMilliseconds)
    expect(hookDeadlineMilliseconds - CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS).toBe(
      CLAUDE_CODE_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS,
    )
  })

  it('fails closed on covered Bash without a session', () => {
    const decision = decideRouting({
      toolName: 'Bash',
      command: 'npm test',
      sessionId: null,
      environment: {},
    })
    expect(decision.action).toBe('block')
    expect(decision.execArgv).toBeNull()
  })

  it('leaves uncovered tools local honestly', () => {
    for (const tool of ['Edit', 'Write', 'Read', 'WebFetch', 'Task']) {
      const decision = decideRouting({
        toolName: tool,
        command: 'x',
        sessionId: 'sess-9',
        environment: {},
      })
      expect(decision.action).toBe('allow-local')
    }
  })

  it('engages the recursion guard for adapter-owned invocations', () => {
    const environment = { OCBOX_AGENT_ROUTED: '1', OCBOX_AGENT_ADAPTER: 'claude-code' }
    const decision = decideRouting({
      toolName: 'Bash',
      command: 'anything',
      sessionId: 's',
      environment,
    })
    expect(decision.action).toBe('allow-local')
    expect(decision.reason).toContain('recursion guard')
    const nested = decideRouting({
      toolName: 'Bash',
      command: 'ocbox agent hook claude-code --session s',
      sessionId: 's',
      environment: {},
    })
    expect(nested.action).toBe('allow-local')
  })

  it('emits a real hook entrypoint that never depends on an undocumented env var', () => {
    const withSession = buildHookCommand('sess-1')
    expect(withSession).toContain(OWNED_HOOK_COMMAND_FRAGMENT)
    expect(withSession).toContain('--session sess-1')
    expect(withSession).not.toContain('CLAUDE_TOOL_COMMAND')
    expect(buildHookCommand(null)).toBe(OWNED_HOOK_COMMAND_FRAGMENT)
  })

  it('round-trips every built hook back through the anchored parser (F2)', () => {
    const session = '11111111-1111-4111-8111-111111111111'
    expect(parseOwnedHookCommand(buildHookCommand(session))).toEqual({ sessionId: session })
    expect(parseOwnedHookCommand(buildHookCommand(null))).toEqual({ sessionId: null })
  })

  it('refuses a Session that would build an undetectable owned hook (F2)', () => {
    expect(() => buildHookCommand('  sess-1  ')).toThrow(/undetectable owned hook/i)
    expect(() => buildHookCommand('sess 1')).toThrow(/undetectable owned hook/i)
    expect(() => buildHookCommand('sess-1\n')).toThrow(/undetectable owned hook/i)
    expect(() => buildHookCommand('')).toThrow(/undetectable owned hook/i)
  })

  it('publishes an exact covered/uncovered matrix in routing-aid language', () => {
    const covered = CAPABILITY_MATRIX.filter((row) => row.status === 'covered')
    const uncovered = CAPABILITY_MATRIX.filter((row) => row.status === 'uncovered')
    expect(covered.length).toBe(2)
    expect(uncovered.length).toBeGreaterThanOrEqual(6)
    expect(ROUTING_AID_NOTICE).toContain('routing aid')
    expect(ROUTING_AID_NOTICE).toContain('not host isolation')
    expect(HOOKABLE_TOOL_NAMES).toContain('Bash')
    expect(HOOK_EVENTS).toContain('PreToolUse')
    const names = CAPABILITY_MATRIX.map((row) => row.capability).join(' ')
    for (const required of ['Edit', 'WebFetch', 'MCP', 'subagent']) {
      expect(names).toContain(required)
    }
    expect(names).toContain('timeout/cancel race')
    const bashRow = covered.find((row) => row.capability.includes('Bash tool calls'))
    expect(bashRow?.detail).toContain('SECONDS')
    expect(bashRow?.detail).toContain('MILLISECONDS')
    expect(bashRow?.detail).toContain('NOT a live Claude Code result')
    expect(bashRow?.detail).toContain('live pin gate')
  })

  it('references exactly one pinned hook/tool surface', () => {
    expect([...HOOKABLE_TOOL_NAMES]).toEqual([...CLAUDE_TOOL_MATCHERS])
    expect([...HOOK_EVENTS]).toEqual([...CLAUDE_HOOK_EVENTS])
    expect(HOOKABLE_TOOL_NAMES).toContain('Bash')
    expect(HOOK_EVENTS).toContain('PreToolUse')
    expect(PINNED_SURFACE_SUMMARY).toContain('single pinned surface')
    expect(CAPABILITY_MATRIX[0]?.detail).toContain('single pinned surface')
  })
})

describe('claude-code exact anti-recursion grammar (F11)', () => {
  const SESSION = 'sess-9'

  it('leaves only the exact owned invocation grammar local', () => {
    for (const command of [
      'ocbox agent hook claude-code',
      'ocbox agent hook claude-code --session sess-9',
      'ocbox agent hook claude-code --session other-session',
    ]) {
      const decision = decideRouting({
        toolName: 'Bash',
        command,
        sessionId: SESSION,
        environment: {},
      })
      expect(decision.action, command).toBe('allow-local')
      expect(decision.execArgv, command).toBeNull()
    }
  })

  it('routes a covered command that merely contains the owned fragment or marker text', () => {
    const commands = [
      'echo ocbox agent hook claude-code',
      "printf '%s' 'ocbox agent hook claude-code'",
      'echo ocbox-claude-code',
      "ocbox exec --session s --shell 'echo ocbox-claude-code'",
      'true && ocbox agent hook claude-code --session sess-9 extra',
    ]
    for (const command of commands) {
      const decision = decideRouting({
        toolName: 'Bash',
        command,
        sessionId: SESSION,
        environment: {},
      })
      expect(decision.action, command).toBe('route')
      expect(decision.execArgv, command).toEqual([
        'exec',
        '--session',
        SESSION,
        '--timeout',
        String(CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS),
        '--shell',
        command,
      ])
    }
  })

  it('does not treat recursion marker text inside a command as a guard', () => {
    const decision = decideRouting({
      toolName: 'Bash',
      command: 'env OCBOX_AGENT_ROUTED=1 OCBOX_AGENT_ADAPTER=claude-code bash',
      sessionId: SESSION,
      environment: {},
    })
    expect(decision.action).toBe('route')
    expect(decision.execArgv).toEqual([
      'exec',
      '--session',
      SESSION,
      '--timeout',
      String(CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS),
      '--shell',
      'env OCBOX_AGENT_ROUTED=1 OCBOX_AGENT_ADAPTER=claude-code bash',
    ])
  })

  it('still honors the real environment recursion markers', () => {
    const decision = decideRouting({
      toolName: 'Bash',
      command: 'npm test',
      sessionId: SESSION,
      environment: { OCBOX_AGENT_ROUTED: '1', OCBOX_AGENT_ADAPTER: 'claude-code' },
    })
    expect(decision.action).toBe('allow-local')
    expect(decision.reason).toContain('recursion guard')
  })
})

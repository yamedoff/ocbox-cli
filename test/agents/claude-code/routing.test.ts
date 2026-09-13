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
import { OWNED_HOOK_COMMAND_FRAGMENT } from '../../../src/agents/claude-code/settings-model.js'

describe('claude-code routing and capability matrix', () => {
  it('routes covered Bash through ocbox exec with a session', () => {
    const decision = decideRouting({
      toolName: 'Bash',
      command: 'npm test',
      sessionId: 'sess-9',
      environment: {},
    })
    expect(decision.action).toBe('route')
    expect(decision.execArgv).toEqual(['exec', '--session', 'sess-9', '--shell', 'npm test'])
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

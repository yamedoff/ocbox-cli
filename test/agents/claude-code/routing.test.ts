import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_MATRIX,
  HOOK_EVENTS,
  HOOKABLE_TOOL_NAMES,
  ROUTING_AID_NOTICE,
} from '../../../src/agents/claude-code/capabilities.js'
import { buildHookCommand, decideRouting } from '../../../src/agents/claude-code/routing.js'
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
})

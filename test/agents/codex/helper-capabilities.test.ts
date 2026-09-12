import { describe, expect, it } from 'vitest'
import {
  COVERED_CAPABILITIES,
  CODEX_ADAPTER_NOTICE,
  UNCOVERED_CAPABILITIES,
  capabilityMatrix,
} from '../../../src/agents/codex/capabilities.js'
import {
  HOOK_FAIL_CLOSED_EXIT_CODE,
  RECURSION_GUARD_ENV,
  SESSION_ENV,
  buildHookArgv,
  buildHookScript,
  buildHookShellCommand,
  hookRouteDecision,
  isRecursionGuardActive,
} from '../../../src/agents/codex/hook-helper.js'

describe('codex hook helper', () => {
  it('routes covered shell calls through the selected ocbox exec Session', () => {
    expect(buildHookArgv({ sessionId: 'sess-1' })).toEqual([
      'ocbox',
      'exec',
      '--session',
      'sess-1',
      '--',
    ])
    expect(buildHookShellCommand({ sessionId: 'sess-1' })).toContain('ocbox')
    expect(buildHookShellCommand({ sessionId: 'sess-1' })).toContain('sess-1')
  })

  it('fails closed when no Session is usable', () => {
    expect(hookRouteDecision({}, null)).toMatchObject({
      route: false,
      reason: 'missing-session-fail-closed',
    })
    expect(hookRouteDecision({}, '')).toMatchObject({ route: false })
    expect(hookRouteDecision({}, 'sess-1')).toMatchObject({ route: true })
  })

  it('never re-triggers the adapter under the recursion guard', () => {
    expect(isRecursionGuardActive({ [RECURSION_GUARD_ENV]: '1' })).toBe(true)
    expect(isRecursionGuardActive({})).toBe(false)
    expect(hookRouteDecision({ [RECURSION_GUARD_ENV]: '1' }, 'sess-1')).toMatchObject({
      route: false,
      reason: 'recursion-guard-active',
    })
  })

  it('emits a guard script with recursion and fail-closed behavior', () => {
    const script = buildHookScript({ sessionId: 'sess-1' })
    expect(script).toContain(RECURSION_GUARD_ENV)
    expect(script).toContain(SESSION_ENV)
    expect(script).toContain('ocbox')
    expect(script).toContain(String(HOOK_FAIL_CLOSED_EXIT_CODE))
    expect(script.startsWith('#!/bin/sh')).toBe(true)
  })
})

describe('codex capability matrix', () => {
  it('is exact and honest about uncovered surfaces', () => {
    const matrix = capabilityMatrix()
    expect(matrix.covered).toEqual([...COVERED_CAPABILITIES])
    expect(matrix.uncovered).toEqual([...UNCOVERED_CAPABILITIES])
    expect(matrix.covered.length).toBeGreaterThan(0)
    expect(matrix.uncovered.length).toBeGreaterThan(0)
    expect(matrix.notice).toBe(CODEX_ADAPTER_NOTICE)
    expect(matrix.notice).toMatch(/routing aid/)
    expect(matrix.notice).toMatch(/not host isolation/)
  })
})

import { describe, expect, it } from 'vitest'
import type { ExecResult } from '../../src/contracts.js'
import {
  ExecutionInfrastructureError,
  exitCodeForExecution,
  outcomeForResult,
} from '../../src/execution/exit-policy.js'
import { timestamps } from '../contracts/test-data.js'

function result(exitCode: number, flags: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    timedOut: false,
    cancelled: false,
    signal: null,
    startedAt: timestamps.created,
    completedAt: timestamps.completed,
    ...flags,
  }
}

describe('execution exit policy', () => {
  it.each([0, 1, 124, 125, 130, 255])('preserves remote exit code %i', (code) => {
    const outcome = outcomeForResult(result(code))
    expect(outcome.kind).toBe('remote_result')
    expect(exitCodeForExecution(outcome)).toBe(code)
  })

  it('reserves policy codes only when the outcome says so', () => {
    expect(exitCodeForExecution(outcomeForResult(result(3, { timedOut: true })))).toBe(124)
    expect(exitCodeForExecution(outcomeForResult(result(3, { cancelled: true })))).toBe(130)
    expect(
      exitCodeForExecution({
        kind: 'infrastructure_error',
        error: new ExecutionInfrastructureError('provider_start'),
      }),
    ).toBe(125)
    expect(exitCodeForExecution({ kind: 'cancelled', result: null })).toBe(130)
  })
})

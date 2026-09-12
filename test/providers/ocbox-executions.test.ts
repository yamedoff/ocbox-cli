import { describe, expect, it } from 'vitest'
import { collectExecutionEvents, toExecResult } from '../../src/providers/ocbox/executions.js'
import { jsonResponse, seededApi } from './doubles.js'

const STARTED_AT = '2026-09-12T10:00:00.000Z'
const EVENT_AT = '2026-09-12T10:00:01.000Z'

function executionFixture(state = 'completed'): Record<string, unknown> {
  return {
    command: 'echo hi',
    createdAt: STARTED_AT,
    exitCode: 3,
    failure: null,
    failureKind: null,
    id: 'exec_hosted_1',
    outputBytes: 12,
    outputLimitBytes: 1048576,
    sandboxId: 'sbx_hosted_1',
    sessionId: 'sess_hosted_1',
    state,
    truncated: false,
    updatedAt: EVENT_AT,
  }
}

describe('hosted execution streaming', () => {
  it('resumes a dropped stream from the last sequence without losing events', async () => {
    const pages = [
      {
        data: [
          { at: EVENT_AT, kind: 'started', message: '', sequence: 0, stream: null },
          { at: EVENT_AT, kind: 'stdout', message: 'hel', sequence: 1, stream: 'stdout' },
        ],
        nextCursor: 'cursor_1',
      },
      {
        data: [{ at: EVENT_AT, kind: 'stdout', message: 'lo', sequence: 2, stream: 'stdout' }],
        nextCursor: null,
      },
    ]
    let eventsCalls = 0
    let executionCalls = 0
    const { api } = await seededApi((input) => {
      const url = String(input)
      if (url.includes('/events')) {
        const page = pages[Math.min(eventsCalls, pages.length - 1)] as unknown
        eventsCalls += 1
        return Promise.resolve(jsonResponse(page))
      }
      if (url.includes('/result')) {
        return Promise.resolve(
          jsonResponse({
            kind: 'command',
            exitCode: 3,
            outputBytes: 5,
            outputLimitBytes: 1048576,
            stderr: '',
            stdout: 'hello',
            truncated: false,
          }),
        )
      }
      executionCalls += 1
      return Promise.resolve(
        jsonResponse(executionFixture(executionCalls === 1 ? 'running' : 'completed')),
      )
    })
    const collected = await collectExecutionEvents(api, 'exec_hosted_1', {
      sleep: () => Promise.resolve(),
    })
    expect(collected.events.map((event) => event.sequence)).toEqual([0, 1, 2])
    expect(eventsCalls).toBeGreaterThanOrEqual(2)
    const result = toExecResult(collected.result, { completedAt: EVENT_AT, startedAt: STARTED_AT })
    expect(result.exitCode).toBe(3)
    expect(result.stdout.byteLength).toBe(0)
    expect(result.stderr.byteLength).toBe(0)
  })

  it('keeps nonzero exits as command results instead of transport failures', () => {
    const result = toExecResult(
      {
        kind: 'command',
        exitCode: 7,
        outputBytes: 1,
        outputLimitBytes: 8,
        stderr: '',
        stdout: 'x',
        truncated: false,
      },
      { completedAt: EVENT_AT, startedAt: STARTED_AT },
    )
    expect(result.exitCode).toBe(7)
    expect(result.cancelled).toBe(false)
  })

  it('maps infrastructure and cancelled results distinctly', () => {
    expect(() =>
      toExecResult(
        { kind: 'infrastructure', error: { code: 'PROVIDER_DOWN', message: 'down' } },
        { completedAt: EVENT_AT, startedAt: STARTED_AT },
      ),
    ).toThrowError(expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }))
    expect(() =>
      toExecResult({ kind: 'cancelled' }, { completedAt: EVENT_AT, startedAt: STARTED_AT }),
    ).toThrowError(expect.objectContaining({ code: 'OPERATION_CANCELLED' }))
  })
})

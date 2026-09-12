import { describe, expect, it } from 'vitest'
import { collectExecutionEvents, toExecResult } from '../../src/providers/ocbox/executions.js'
import { errorResponse, jsonResponse, seededApi } from './doubles.js'

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

  it('drains events from the saved cursor after the stream drops before the terminal result', async () => {
    let eventsCalls = 0
    const { api } = await seededApi((input) => {
      const url = String(input)
      if (url.includes('/events')) {
        eventsCalls += 1
        if (eventsCalls === 1) {
          return Promise.resolve(
            jsonResponse({
              data: [
                { at: EVENT_AT, kind: 'started', message: '', sequence: 0, stream: null },
                { at: EVENT_AT, kind: 'stdout', message: 'hel', sequence: 1, stream: 'stdout' },
              ],
              nextCursor: 'cursor_1',
            }),
          )
        }
        if (eventsCalls <= 5) {
          return Promise.resolve(errorResponse('SERVICE_UNAVAILABLE', 503))
        }
        return Promise.resolve(
          jsonResponse({
            data: [{ at: EVENT_AT, kind: 'stdout', message: 'lo', sequence: 2, stream: 'stdout' }],
            nextCursor: null,
          }),
        )
      }
      if (url.includes('/result')) {
        return Promise.resolve(
          jsonResponse({
            kind: 'command',
            exitCode: 0,
            outputBytes: 5,
            outputLimitBytes: 1048576,
            stderr: '',
            stdout: 'hello',
            truncated: false,
          }),
        )
      }
      return Promise.resolve(jsonResponse(executionFixture('completed')))
    })
    const collected = await collectExecutionEvents(api, 'exec_hosted_1', {
      sleep: () => Promise.resolve(),
    })
    expect(collected.events.map((event) => event.sequence)).toEqual([0, 1, 2])
    expect(collected.events.map((event) => event.message)).toEqual(['', 'hel', 'lo'])
    expect(eventsCalls).toBeGreaterThanOrEqual(6)
  })

  it('caps a hostile Retry-After sleep by the remaining deadline', async () => {
    let clock = 0
    const sleeps: number[] = []
    const { api } = await seededApi(() =>
      Promise.resolve(errorResponse('RATE_LIMITED', 429, undefined, 86_400)),
    )
    await expect(
      collectExecutionEvents(api, 'exec_hosted_1', {
        deadlineMilliseconds: 5_000,
        maxStreamFailures: 10,
        now: () => clock,
        sleep: (milliseconds) => {
          sleeps.push(milliseconds)
          clock += milliseconds
          return Promise.resolve()
        },
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
    expect(sleeps).toHaveLength(1)
    expect(sleeps[0]).toBeLessThanOrEqual(5_000)
  })

  it('resets a stale cursor and resumes without duplicating events', async () => {
    const cursors: Array<string | null> = []
    const { api } = await seededApi((input) => {
      const url = String(input)
      if (url.includes('/events')) {
        cursors.push(new URL(url).searchParams.get('cursor'))
        if (cursors.length === 1) {
          return Promise.resolve(errorResponse('INVALID_CURSOR', 422))
        }
        return Promise.resolve(
          jsonResponse({
            data: [
              { at: EVENT_AT, kind: 'started', message: '', sequence: 0, stream: null },
              { at: EVENT_AT, kind: 'stdout', message: 'seen', sequence: 1, stream: 'stdout' },
              { at: EVENT_AT, kind: 'stdout', message: 'tail', sequence: 2, stream: 'stdout' },
              { at: EVENT_AT, kind: 'completed', message: '', sequence: 3, stream: null },
            ],
            nextCursor: null,
          }),
        )
      }
      if (url.includes('/result')) {
        return Promise.resolve(
          jsonResponse({
            kind: 'command',
            exitCode: 0,
            outputBytes: 4,
            outputLimitBytes: 1048576,
            stderr: '',
            stdout: 'tail',
            truncated: false,
          }),
        )
      }
      return Promise.resolve(jsonResponse(executionFixture('completed')))
    })
    const collected = await collectExecutionEvents(api, 'exec_hosted_1', {
      checkpoint: { cursor: 'stale_cursor', executionId: 'exec_hosted_1', lastSequence: 1 },
      sleep: () => Promise.resolve(),
    })
    expect(cursors).toEqual(['stale_cursor', null])
    expect(collected.events.map((event) => event.sequence)).toEqual([2, 3])
    expect(new Set(collected.events.map((event) => event.sequence)).size).toBe(
      collected.events.length,
    )
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

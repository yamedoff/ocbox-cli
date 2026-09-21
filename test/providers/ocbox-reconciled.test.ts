import { describe, expect, it, vi } from 'vitest'
import { mapApiFailureToOcboxError } from '../../src/api/client/errors.js'
import { ExecutionIdSchema } from '../../src/domain/ids.js'
import { consumeExecutionOutput } from '../../src/execution/stream-output.js'
import {
  MemoryOperationCheckpointStore,
  cancelHostedOperation,
  waitForHostedOperation,
} from '../../src/providers/ocbox/operations.js'
import { toExecEvents, toExecResult } from '../../src/providers/ocbox/executions.js'
import {
  computeBackoffMilliseconds,
  parseRetryAfterSeconds,
  resolvePollDelayMilliseconds,
} from '../../src/providers/ocbox/retry.js'
import { errorResponse, hostedOperationFixture, jsonResponse, seededApi } from './doubles.js'

const REQUEST_ID = '11111111-1111-4111-8111-111111111111'

describe('t14 reconciled invariants', () => {
  it('replays a terminal operation from a durable checkpoint without network', async () => {
    const store = new MemoryOperationCheckpointStore()
    const { api: first } = await seededApi(() =>
      Promise.resolve(jsonResponse(hostedOperationFixture({ state: 'succeeded' }))),
    )
    await waitForHostedOperation(first, 'op_hosted_1', {
      sleep: () => Promise.resolve(),
      store,
    })
    const { api: second } = await seededApi(() =>
      Promise.reject(new Error('restarted waiter must not hit the network')),
    )
    const replayed = await waitForHostedOperation(second, 'op_hosted_1', {
      sleep: () => Promise.resolve(),
      store,
    })
    expect(replayed.fromCheckpoint).toBe(true)
    expect(replayed.operation.state).toBe('succeeded')
  })

  it('reuses the caller idempotency key across retryable remote cancels', async () => {
    const keys: string[] = []
    const { api } = await seededApi((input, init) => {
      const url = String(input)
      if (url.includes('/operations/') && url.endsWith('/cancel')) {
        const key = new Headers(init?.headers).get('idempotency-key') ?? ''
        keys.push(key)
        if (keys.length === 1) {
          return Promise.resolve(errorResponse('SERVICE_UNAVAILABLE', 503, REQUEST_ID, 0))
        }
        return Promise.resolve(jsonResponse(hostedOperationFixture({ state: 'cancelled' })))
      }
      return Promise.resolve(jsonResponse(hostedOperationFixture({})))
    })
    const key = 'cancel-key-0123456789-abcd'
    await cancelHostedOperation(api, 'op_hosted_1', key)
    expect(keys).toEqual([key, key])
  })

  it('renumbers gapped server sequences into dense output-capture order', async () => {
    const executionId = ExecutionIdSchema.parse('22222222-2222-4222-8222-222222222222')
    const events = toExecEvents(
      executionId,
      [
        { at: '2026-09-12T10:00:00.000Z', kind: 'started', message: '', sequence: 0, stream: null },
        {
          at: '2026-09-12T10:00:01.000Z',
          kind: 'stdout',
          message: 'a',
          sequence: 1,
          stream: 'stdout',
        },
        {
          at: '2026-09-12T10:00:02.000Z',
          kind: 'progress',
          message: '50',
          sequence: 2,
          stream: null,
        },
        {
          at: '2026-09-12T10:00:03.000Z',
          kind: 'stderr',
          message: 'b',
          sequence: 5,
          stream: 'stderr',
        },
      ] as never,
      { startedAt: '2026-09-12T10:00:00.000Z' },
    )
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2])
    expect(events.map((event) => event.type)).toEqual(['started', 'stdout', 'stderr'])
    const result = toExecResult(
      {
        kind: 'command',
        exitCode: 3,
        outputBytes: 2,
        outputLimitBytes: 8,
        stderr: '',
        stdout: '',
        truncated: false,
      } as never,
      { completedAt: '2026-09-12T10:00:04.000Z', startedAt: '2026-09-12T10:00:00.000Z' },
    )
    expect(result.stdout.byteLength).toBe(0)
    async function* stream() {
      for (const event of events) yield event
      yield {
        executionId,
        result,
        sequence: events.length,
        timestamp: result.completedAt,
        type: 'completed',
      } as never
    }
    const captured = await consumeExecutionOutput(executionId, stream(), async () => undefined)
    expect(captured.result.exitCode).toBe(3)
    expect(captured.stdout.data).toBe(Buffer.from('a').toString('base64'))
  })

  it('rejects out-of-range remote exit codes without treating them as success', () => {
    expect(() =>
      toExecResult(
        {
          kind: 'command',
          exitCode: 999,
          outputBytes: 0,
          outputLimitBytes: 8,
          stderr: '',
          stdout: '',
          truncated: false,
        } as never,
        { completedAt: '2026-09-12T10:00:01.000Z', startedAt: '2026-09-12T10:00:00.000Z' },
      ),
    ).toThrowError(expect.objectContaining({ code: 'INTERNAL' }))
  })

  it('rejects an operation identity mismatch instead of attributing foreign state', async () => {
    const { api } = await seededApi(() =>
      Promise.resolve(jsonResponse(hostedOperationFixture({ id: 'op_foreign' }))),
    )
    await expect(
      waitForHostedOperation(api, 'op_hosted_1', { sleep: () => Promise.resolve() }),
    ).rejects.toMatchObject({ code: 'INTERNAL' })
  })

  it('preserves catalogue codes, server request IDs, and retry hints losslessly', () => {
    const error = mapApiFailureToOcboxError({
      operation: 'getOperation',
      requestId: REQUEST_ID,
      responseRequestId: 'srv-req-9',
      retryAfterSeconds: 3,
      serverCode: 'OPERATION_CONFLICT',
      status: 409,
    })
    expect(error.code).toBe('OPERATION_CONFLICT')
    expect(error.providerCode).toBe('OPERATION_CONFLICT')
    expect(error.details).toMatchObject({ providerRequestId: 'srv-req-9', retryAfterSeconds: 3 })
    expect(error.retryable).toBe(true)
  })

  it('shares deterministic retry primitives across operation and execution waits', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    expect(parseRetryAfterSeconds('7', now)).toBe(7)
    expect(parseRetryAfterSeconds('999999', now)).toBeNull()
    expect(resolvePollDelayMilliseconds({ attempt: 1, retryAfterSeconds: 2 })).toBe(2_000)
    expect(
      computeBackoffMilliseconds(
        2,
        { baseMilliseconds: 100, jitterRatio: 0, maxMilliseconds: 10_000, multiplier: 2 },
        () => 0,
      ),
    ).toBe(200)
    expect(vi.fn().mock.calls.length).toBe(0)
  })
})

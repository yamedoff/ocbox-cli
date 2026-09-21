import { describe, expect, it } from 'vitest'
import {
  MemoryOperationCheckpointStore,
  cancelHostedOperation,
  waitForHostedOperation,
} from '../../src/providers/ocbox/operations.js'
import { OcboxError } from '../../src/errors/index.js'
import { errorResponse, hostedOperationFixture, jsonResponse, seededApi } from './doubles.js'

const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const CANCEL_KEY = 'cancel-key-0123456789-abcd'

describe('hosted operation waiter', () => {
  it('polls pending operations to success and survives a CLI restart', async () => {
    let calls = 0
    const { api } = await seededApi(() => {
      calls += 1
      if (calls === 1)
        return Promise.resolve(jsonResponse(hostedOperationFixture({ state: 'running' })))
      return Promise.resolve(jsonResponse(hostedOperationFixture({ state: 'succeeded' })))
    })
    const first = await waitForHostedOperation(api, 'op_hosted_1', {
      sleep: () => Promise.resolve(),
    })
    expect(first.operation.state).toBe('succeeded')
    const { api: restarted } = await seededApi(() =>
      Promise.resolve(jsonResponse(hostedOperationFixture({ state: 'succeeded' }))),
    )
    const second = await waitForHostedOperation(restarted, 'op_hosted_1', {
      sleep: () => Promise.resolve(),
    })
    expect(second.operation.state).toBe('succeeded')
    expect(calls).toBe(2)
  })

  it('obeys 429 retry hints and enforces the deadline', async () => {
    const { api } = await seededApi(() =>
      Promise.resolve(
        errorResponse('RATE_LIMITED', 429, '11111111-1111-4111-8111-111111111111', 5),
      ),
    )
    let elapsed = 0
    const sleeps: number[] = []
    await expect(
      waitForHostedOperation(api, 'op_hosted_1', {
        deadlineMilliseconds: 6_000,
        now: () => elapsed,
        sleep: (ms) => {
          sleeps.push(ms)
          elapsed += ms
          return Promise.resolve()
        },
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
    expect(sleeps[0]).toBe(5000)
  })

  it('maps terminal failures and cancellations losslessly', async () => {
    const { api: failedApi } = await seededApi(() =>
      Promise.resolve(
        jsonResponse(
          hostedOperationFixture({
            error: { code: 'SESSION_STATE_CONFLICT', message: 'conflict' },
            state: 'failed',
          }),
        ),
      ),
    )
    await expect(
      waitForHostedOperation(failedApi, 'op_hosted_1', { sleep: () => Promise.resolve() }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
    const { api: cancelledApi } = await seededApi(() =>
      Promise.resolve(jsonResponse(hostedOperationFixture({ state: 'cancelled' }))),
    )
    await expect(
      waitForHostedOperation(cancelledApi, 'op_hosted_1', { sleep: () => Promise.resolve() }),
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
  })

  it('honours caller cancellation', async () => {
    const { api } = await seededApi(() =>
      Promise.resolve(jsonResponse(hostedOperationFixture({ state: 'running' }))),
    )
    const controller = new AbortController()
    controller.abort()
    await expect(
      waitForHostedOperation(api, 'op_hosted_1', {
        signal: controller.signal,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toBeInstanceOf(OcboxError)
  })

  it('rejects a failed checkpoint replay with the same mapped error as live polling', async () => {
    const store = new MemoryOperationCheckpointStore()
    const { api: live } = await seededApi(() =>
      Promise.resolve(
        jsonResponse(
          hostedOperationFixture({
            error: { code: 'SESSION_STATE_CONFLICT', message: 'conflict' },
            state: 'failed',
          }),
        ),
      ),
    )
    const liveError = await waitForHostedOperation(live, 'op_hosted_1', {
      sleep: () => Promise.resolve(),
      store,
    }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(liveError).toMatchObject({
      code: 'OPERATION_CONFLICT',
      providerCode: 'SESSION_STATE_CONFLICT',
    })

    const { api: restarted } = await seededApi(() =>
      Promise.reject(new Error('restarted waiter must not hit the network')),
    )
    await expect(
      waitForHostedOperation(restarted, 'op_hosted_1', {
        sleep: () => Promise.resolve(),
        store,
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
  })

  it('rejects a cancelled checkpoint replay without reporting success', async () => {
    const store = new MemoryOperationCheckpointStore()
    const { api: live } = await seededApi(() =>
      Promise.resolve(jsonResponse(hostedOperationFixture({ state: 'cancelled' }))),
    )
    await expect(
      waitForHostedOperation(live, 'op_hosted_1', { sleep: () => Promise.resolve(), store }),
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })

    const { api: restarted } = await seededApi(() =>
      Promise.reject(new Error('restarted waiter must not hit the network')),
    )
    await expect(
      waitForHostedOperation(restarted, 'op_hosted_1', {
        sleep: () => Promise.resolve(),
        store,
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
  })

  it('rides out transient 500 and 502 poll failures within the deadline', async () => {
    let calls = 0
    const { api } = await seededApi(() => {
      calls += 1
      if (calls === 1) return Promise.resolve(errorResponse('INTERNAL', 500, REQUEST_ID))
      if (calls === 2) return Promise.resolve(errorResponse('BAD_GATEWAY', 502, REQUEST_ID))
      return Promise.resolve(jsonResponse(hostedOperationFixture({ state: 'succeeded' })))
    })
    const result = await waitForHostedOperation(api, 'op_hosted_1', {
      sleep: () => Promise.resolve(),
    })
    expect(result.operation.state).toBe('succeeded')
    expect(calls).toBe(3)
  })

  it('bounds transient 500 retries by the deadline instead of surfacing INTERNAL', async () => {
    let calls = 0
    const { api } = await seededApi(() => {
      calls += 1
      return Promise.resolve(errorResponse('INTERNAL', 500, REQUEST_ID))
    })
    let elapsed = 0
    await expect(
      waitForHostedOperation(api, 'op_hosted_1', {
        deadlineMilliseconds: 1000,
        now: () => elapsed,
        sleep: (milliseconds) => {
          elapsed += milliseconds
          return Promise.resolve()
        },
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
    expect(calls).toBeGreaterThan(1)
  })

  it('retains the latest known operation state across a retryable poll failure', async () => {
    const store = new MemoryOperationCheckpointStore()
    let calls = 0
    const { api } = await seededApi(() => {
      calls += 1
      if (calls === 1) {
        return Promise.resolve(
          jsonResponse(hostedOperationFixture({ progress: 42, state: 'running' })),
        )
      }
      return Promise.resolve(errorResponse('SERVICE_UNAVAILABLE', 503, REQUEST_ID))
    })
    let elapsed = 0
    await expect(
      waitForHostedOperation(api, 'op_hosted_1', {
        deadlineMilliseconds: 1000,
        now: () => elapsed,
        sleep: (milliseconds) => {
          elapsed += milliseconds
          return Promise.resolve()
        },
        store,
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })

    const saved = await store.load('op_hosted_1')
    expect(saved?.state).toBe('running')
    expect(saved?.progress).toBe(42)
    expect(saved?.operation?.state).toBe('running')
  })

  it('fails fast on a non-cancellable operation instead of retrying to the deadline', async () => {
    let calls = 0
    const { api } = await seededApi(() => {
      calls += 1
      return Promise.resolve(errorResponse('OPERATION_NOT_CANCELLABLE', 409, REQUEST_ID))
    })
    await expect(cancelHostedOperation(api, 'op_hosted_1', CANCEL_KEY)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      providerCode: 'OPERATION_NOT_CANCELLABLE',
    })
    expect(calls).toBe(1)
  })
})

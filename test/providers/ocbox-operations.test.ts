import { describe, expect, it } from 'vitest'
import { waitForHostedOperation } from '../../src/providers/ocbox/operations.js'
import { OcboxError } from '../../src/errors/index.js'
import { errorResponse, hostedOperationFixture, jsonResponse, seededApi } from './doubles.js'

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
})

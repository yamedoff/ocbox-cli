import { describe, expect, it } from 'vitest'
import { MemoryOperationCheckpointStore } from '../../src/providers/ocbox/operations.js'
import {
  executionWaitDeadlineMilliseconds,
  OcboxSandboxProvider,
} from '../../src/providers/ocbox/provider.js'
import {
  HOSTED_PROJECT,
  HOSTED_SANDBOX,
  HOSTED_SESSION,
  LOCAL_IDS,
  errorResponse,
  hostedOperationFixture,
  hostedSessionFixture,
  jsonResponse,
  operationContext,
  seededApi,
  testSpec,
} from './doubles.js'

function projectFixture(): Record<string, unknown> {
  return {
    createdAt: '2026-09-12T10:00:00.000Z',
    id: HOSTED_PROJECT,
    name: 'hosted project',
    updatedAt: '2026-09-12T10:00:00.000Z',
  }
}

function routeFetch(scenario: 'happy' | 'incompatible' | 'missing-project') {
  return (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.endsWith(`/projects/${HOSTED_PROJECT}`) && method === 'GET') {
      if (scenario === 'missing-project') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: 'NOT_FOUND', message: 'no' },
              requestId: LOCAL_IDS.request,
            }),
            {
              headers: { 'x-request-id': LOCAL_IDS.request },
              status: 404,
            },
          ),
        )
      }
      return Promise.resolve(jsonResponse(projectFixture()))
    }
    if (url.endsWith(`/projects/${HOSTED_PROJECT}/sessions`) && method === 'POST') {
      return Promise.resolve(jsonResponse(hostedOperationFixture({}), 202))
    }
    if (url.includes('/operations/') && method === 'GET') {
      return Promise.resolve(jsonResponse(hostedOperationFixture({})))
    }
    if (url.endsWith(`/sessions/${HOSTED_SESSION}`) && method === 'GET') {
      if (scenario === 'incompatible') {
        return Promise.resolve(
          jsonResponse(
            hostedSessionFixture({
              sandboxes: [
                {
                  active: true,
                  boundAt: '2026-09-12T10:00:00.000Z',
                  ordinal: 0,
                  releasedAt: null,
                  role: 'primary',
                  sandboxId: 'sbx_a',
                  state: 'running',
                },
                {
                  active: true,
                  boundAt: '2026-09-12T10:00:01.000Z',
                  ordinal: 1,
                  releasedAt: null,
                  role: 'primary',
                  sandboxId: 'sbx_b',
                  state: 'running',
                },
              ],
            }),
          ),
        )
      }
      return Promise.resolve(jsonResponse(hostedSessionFixture({})))
    }
    if (url.includes(`/sessions/${HOSTED_SESSION}/start`) && method === 'POST') {
      return Promise.resolve(
        jsonResponse(hostedOperationFixture({ id: 'op_start_1', kind: 'session_start' }), 202),
      )
    }
    return Promise.resolve(jsonResponse({}))
  }
}

describe('hosted ocbox provider lifecycle', () => {
  it('creates a sandbox from the ordered primary binding with replay metadata', async () => {
    const { api } = await seededApi(routeFetch('happy'))
    const provider = new OcboxSandboxProvider({ api, hostedProjectId: HOSTED_PROJECT })
    const context = operationContext()
    const result = await provider.create(
      context as never,
      {
        adoption: {
          metadata: { operationId: context.operationId, sessionId: LOCAL_IDS.session },
          strategy: 'serialize_then_reconcile',
        },
        projectId: LOCAL_IDS.project,
        sessionId: LOCAL_IDS.session,
        specification: testSpec() as never,
      } as never,
    )
    expect(result.sandbox.provider).toBe('ocbox')
    expect(result.sandbox.providerSandboxId).toBe('sbx_hosted_1')
    expect(result.operation.action).toBe('create')
    expect(result.operation.id).toBe(context.operationId)
    expect(result.operation.providerVerifiedAt).toBe(result.sandbox.lifecycle.observedAt)
    const fetched = await provider.get(
      { issuedAt: context.issuedAt, requestId: context.requestId } as never,
      {
        sandboxId: result.sandbox.id,
      } as never,
    )
    expect(fetched?.id).toBe(result.sandbox.id)
  })

  it('rejects incompatible multi-binding servers instead of targeting silently', async () => {
    const { api } = await seededApi(routeFetch('incompatible'))
    const provider = new OcboxSandboxProvider({ api, hostedProjectId: HOSTED_PROJECT })
    const context = operationContext()
    await expect(
      provider.create(
        context as never,
        {
          adoption: {
            metadata: { operationId: context.operationId, sessionId: LOCAL_IDS.session },
            strategy: 'serialize_then_reconcile',
          },
          projectId: LOCAL_IDS.project,
          sessionId: LOCAL_IDS.session,
          specification: testSpec() as never,
        } as never,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      providerCode: 'MULTIPLE_ACTIVE_PRIMARY_BINDINGS',
    })
  })

  it('maps a missing hosted project without trusting provider IDs', async () => {
    const { api } = await seededApi(routeFetch('missing-project'))
    const provider = new OcboxSandboxProvider({ api, hostedProjectId: HOSTED_PROJECT })
    const context = operationContext()
    await expect(
      provider.create(
        context as never,
        {
          adoption: {
            metadata: { operationId: context.operationId, sessionId: LOCAL_IDS.session },
            strategy: 'serialize_then_reconcile',
          },
          projectId: LOCAL_IDS.project,
          sessionId: LOCAL_IDS.session,
          specification: testSpec() as never,
        } as never,
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
  })

  it('keeps bearer material out of errors and diagnostics', async () => {
    const seen: string[] = []
    const { api } = await seededApi((input, init) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '')
      return routeFetch('happy')(input, init)
    })
    const provider = new OcboxSandboxProvider({ api, hostedProjectId: HOSTED_PROJECT })
    const context = operationContext()
    const result = await provider.create(
      context as never,
      {
        adoption: {
          metadata: { operationId: context.operationId, sessionId: LOCAL_IDS.session },
          strategy: 'serialize_then_reconcile',
        },
        projectId: LOCAL_IDS.project,
        sessionId: LOCAL_IDS.session,
        specification: testSpec() as never,
      } as never,
    )
    expect(seen[0]?.startsWith('Bearer ')).toBe(true)
    expect(JSON.stringify(result)).not.toContain(seen[0]?.replace('Bearer ', '') ?? 'a'.repeat(48))
  })

  it('resumes a lifecycle wait from a durable checkpoint after a provider restart', async () => {
    const store = new MemoryOperationCheckpointStore()
    const context = operationContext()
    const request = {
      adoption: {
        metadata: { operationId: context.operationId, sessionId: LOCAL_IDS.session },
        strategy: 'serialize_then_reconcile',
      },
      projectId: LOCAL_IDS.project,
      sessionId: LOCAL_IDS.session,
      specification: testSpec() as never,
    }
    const { api: first } = await seededApi(routeFetch('happy'))
    const providerA = new OcboxSandboxProvider({
      api: first,
      checkpointDurability: 'durable',
      checkpointStore: store,
      hostedProjectId: HOSTED_PROJECT,
    })
    await providerA.create(context as never, request as never)

    let operationsPolls = 0
    const { api: restarted } = await seededApi((input, init) => {
      if (String(input).includes('/operations/')) {
        operationsPolls += 1
        return Promise.reject(new Error('restarted waiter must not poll operations'))
      }
      return routeFetch('happy')(input, init)
    })
    const providerB = new OcboxSandboxProvider({
      api: restarted,
      checkpointDurability: 'durable',
      checkpointStore: store,
      hostedProjectId: HOSTED_PROJECT,
    })
    const result = await providerB.create(context as never, request as never)
    expect(result.sandbox.providerSandboxId).toBe('sbx_hosted_1')
    expect(operationsPolls).toBe(0)
  })

  it('defaults to an explicit ephemeral policy and rejects durable without a store', async () => {
    const { api } = await seededApi(routeFetch('happy'))
    const provider = new OcboxSandboxProvider({ api, hostedProjectId: HOSTED_PROJECT })
    expect(provider.checkpointDurability).toBe('ephemeral')
    expect(
      () =>
        new OcboxSandboxProvider({
          api,
          checkpointDurability: 'durable',
          hostedProjectId: HOSTED_PROJECT,
        }),
    ).toThrow(TypeError)
  })

  it('binds the execution wait deadline to the requested timeout or advertised maximum', () => {
    expect(executionWaitDeadlineMilliseconds(600_000, 3_600_000)).toBe(630_000)
    expect(executionWaitDeadlineMilliseconds(null, 3_600_000)).toBe(3_630_000)
    expect(executionWaitDeadlineMilliseconds(600_000, 3_600_000)).toBeGreaterThan(600_000)
    expect(executionWaitDeadlineMilliseconds(null, 3_600_000)).toBeGreaterThan(3_600_000)
  })

  it('returns a live execution handle promptly and keeps mid-flight cancel reachable', async () => {
    const HOSTED_EXECUTION = 'exec_hosted_1'
    const STARTED_AT = '2026-09-12T10:00:00.000Z'
    const cancelled: string[] = []
    const { api } = await seededApi((input, init) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.endsWith(`/projects/${HOSTED_PROJECT}`) && method === 'GET') {
        return Promise.resolve(jsonResponse(projectFixture()))
      }
      if (url.endsWith(`/sessions/${HOSTED_SESSION}`) && method === 'GET') {
        return Promise.resolve(jsonResponse(hostedSessionFixture({})))
      }
      if (url.endsWith(`/sessions/${HOSTED_SESSION}/executions`) && method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              createdAt: STARTED_AT,
              id: HOSTED_EXECUTION,
              sandboxId: HOSTED_SANDBOX,
              sessionId: HOSTED_SESSION,
              state: 'running',
            },
            202,
          ),
        )
      }
      if (url.includes(`/executions/${HOSTED_EXECUTION}/events`)) {
        if (!url.includes('cursor=')) {
          return Promise.resolve(
            jsonResponse({
              data: [
                {
                  at: '2026-09-12T10:00:00.000Z',
                  kind: 'started',
                  message: '',
                  sequence: 0,
                  stream: null,
                },
                {
                  at: '2026-09-12T10:00:01.000Z',
                  kind: 'stdout',
                  message: 'hi',
                  sequence: 1,
                  stream: 'stdout',
                },
              ],
              nextCursor: 'cursor_live',
            }),
          )
        }
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          const onAbort = (): void =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (signal?.aborted === true) onAbort()
          else signal?.addEventListener('abort', onAbort, { once: true })
        })
      }
      if (url.includes(`/executions/${HOSTED_EXECUTION}/cancel`) && method === 'POST') {
        cancelled.push('cancel')
        return Promise.resolve(jsonResponse({ id: HOSTED_EXECUTION, state: 'cancelled' }, 202))
      }
      return Promise.resolve(jsonResponse({}))
    })
    const provider = new OcboxSandboxProvider({ api, hostedProjectId: HOSTED_PROJECT })
    provider.seedForTests({
      hostedSandboxId: HOSTED_SANDBOX,
      hostedSessionId: HOSTED_SESSION,
      localId: LOCAL_IDS.sandbox,
      localProjectId: LOCAL_IDS.project,
      localSessionId: LOCAL_IDS.session,
      spec: testSpec() as never,
    })
    const context = operationContext()
    const handle = await Promise.race([
      provider.exec.execute(
        context as never,
        {
          command: { mode: 'argv', argv: ['sleep', '30'] },
          environment: {},
          sandboxId: LOCAL_IDS.sandbox,
          timeoutMilliseconds: 3_600_000,
          workingDirectory: null,
        } as never,
      ),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('execute blocked on completion')), 1_000),
      ),
    ])
    expect(handle.execution.status).toBe('running')
    let settled = false
    void handle.result.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    const iterator = handle.events[Symbol.asyncIterator]()
    const started = await iterator.next()
    const stdout = await iterator.next()
    expect(started.value?.type).toBe('started')
    expect(stdout.value?.type).toBe('stdout')
    expect(settled).toBe(false)
    const operation = await provider.exec.cancel(
      context as never,
      {
        executionId: handle.execution.id,
      } as never,
    )
    expect(operation.action).toBe('exec_cancel')
    expect(cancelled).toEqual(['cancel'])
    await expect(handle.result).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
  })

  it('treats a post-deletion getSession 404 as a verified destroy', async () => {
    let destroyCalls = 0
    let sessionCalls = 0
    const { api } = await seededApi((input, init) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.endsWith(`/projects/${HOSTED_PROJECT}`) && method === 'GET') {
        return Promise.resolve(jsonResponse(projectFixture()))
      }
      if (url.endsWith(`/sessions/${HOSTED_SESSION}/destroy`) && method === 'POST') {
        destroyCalls += 1
        return Promise.resolve(
          jsonResponse(
            hostedOperationFixture({ id: 'op_destroy_1', kind: 'session_destroy' }),
            202,
          ),
        )
      }
      if (url.includes('/operations/op_destroy_1') && method === 'GET') {
        return Promise.resolve(
          jsonResponse(hostedOperationFixture({ id: 'op_destroy_1', kind: 'session_destroy' })),
        )
      }
      if (url.endsWith(`/sessions/${HOSTED_SESSION}`) && method === 'GET') {
        sessionCalls += 1
        return Promise.resolve(errorResponse('NOT_FOUND', 404))
      }
      return Promise.resolve(jsonResponse({}))
    })
    const provider = new OcboxSandboxProvider({ api, hostedProjectId: HOSTED_PROJECT })
    provider.seedForTests({
      hostedSandboxId: HOSTED_SANDBOX,
      hostedSessionId: HOSTED_SESSION,
      localId: LOCAL_IDS.sandbox,
      localProjectId: LOCAL_IDS.project,
      localSessionId: LOCAL_IDS.session,
      spec: testSpec() as never,
    })
    const result = await provider.destroy(
      operationContext() as never,
      {
        sandboxId: LOCAL_IDS.sandbox,
      } as never,
    )
    expect(destroyCalls).toBe(1)
    expect(sessionCalls).toBe(1)
    expect(result.sandbox.lifecycle.normalizedState).toBe('deleted')
    expect(result.operation.action).toBe('destroy')
  })

  it('replays an idempotent destroy after the session is already deleted', async () => {
    const destroyCalls: boolean[] = []
    let sessionCalls = 0
    const { api } = await seededApi((input, init) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.endsWith(`/projects/${HOSTED_PROJECT}`) && method === 'GET') {
        return Promise.resolve(jsonResponse(projectFixture()))
      }
      if (url.endsWith(`/sessions/${HOSTED_SESSION}/destroy`) && method === 'POST') {
        const replay = destroyCalls.length > 0
        destroyCalls.push(replay)
        const headers: Record<string, string> = {
          'x-request-id': '11111111-1111-4111-8111-111111111111',
        }
        if (replay) headers['idempotency-replayed'] = 'true'
        return Promise.resolve(
          new Response(
            JSON.stringify(hostedOperationFixture({ id: 'op_destroy_1', kind: 'session_destroy' })),
            { headers, status: 202 },
          ),
        )
      }
      if (url.includes('/operations/op_destroy_1') && method === 'GET') {
        return Promise.resolve(
          jsonResponse(hostedOperationFixture({ id: 'op_destroy_1', kind: 'session_destroy' })),
        )
      }
      if (url.endsWith(`/sessions/${HOSTED_SESSION}`) && method === 'GET') {
        sessionCalls += 1
        return Promise.resolve(errorResponse('NOT_FOUND', 404))
      }
      return Promise.resolve(jsonResponse({}))
    })
    const provider = new OcboxSandboxProvider({ api, hostedProjectId: HOSTED_PROJECT })
    provider.seedForTests({
      hostedSandboxId: HOSTED_SANDBOX,
      hostedSessionId: HOSTED_SESSION,
      localId: LOCAL_IDS.sandbox,
      localProjectId: LOCAL_IDS.project,
      localSessionId: LOCAL_IDS.session,
      spec: testSpec() as never,
    })
    const context = operationContext()
    const first = await provider.destroy(
      context as never,
      {
        sandboxId: LOCAL_IDS.sandbox,
      } as never,
    )
    const second = await provider.destroy(
      context as never,
      {
        sandboxId: LOCAL_IDS.sandbox,
      } as never,
    )
    expect(destroyCalls).toEqual([false, true])
    expect(sessionCalls).toBe(2)
    expect(first.operation.idempotencyResolution?.kind).toBe('created')
    expect(second.operation.idempotencyResolution?.kind).toBe('replayed_result')
    expect(second.sandbox.lifecycle.normalizedState).toBe('deleted')
  })
})

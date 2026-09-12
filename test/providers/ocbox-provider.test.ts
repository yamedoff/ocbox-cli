import { describe, expect, it } from 'vitest'
import { OcboxSandboxProvider } from '../../src/providers/ocbox/provider.js'
import {
  HOSTED_PROJECT,
  HOSTED_SESSION,
  LOCAL_IDS,
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
})

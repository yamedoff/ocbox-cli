import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectIdSchema, SandboxIdSchema } from '../../src/domain/ids.js'
import { LifecycleStore } from '../../src/lifecycle/store.js'
import { OcboxSandboxProvider } from '../../src/providers/ocbox/provider.js'
import { ADMISSION_MESSAGES } from '../../src/providers/ocbox/requested-spec.js'
import {
  errorResponse,
  HOSTED_PROJECT,
  HOSTED_SANDBOX,
  HOSTED_SESSION,
  hostedOperationFixture,
  hostedSessionFixture,
  jsonResponse,
  LOCAL_IDS,
  operationContext,
  seededApi,
  testSpec,
} from './doubles.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const scope = 'scope'
const admissionCode = 'admission_closed'

const createRequest = {
  projectId: LOCAL_IDS.project,
  sessionId: LOCAL_IDS.session,
  specification: testSpec(),
}
const provisioningSession = () =>
  hostedSessionFixture({
    normalizedState: 'provisioning',
    rawState: 'provisioning',
  })
function fakeWait(deadlineMilliseconds = 1000) {
  let elapsed = 0
  const sleeps: number[] = []
  return {
    sleeps,
    options: {
      deadlineMilliseconds,
      now: () => elapsed,
      random: () => 0,
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds)
        elapsed += milliseconds
      },
    },
  }
}
function providerFor(api: Awaited<ReturnType<typeof seededApi>>['api'], wait = fakeWait()) {
  const provider = new OcboxSandboxProvider({
    api,
    hostedProjectId: HOSTED_PROJECT,
    createId: () => LOCAL_IDS.sandbox,
    waitOptions: wait.options,
  })
  return { provider, wait }
}
function seed(provider: OcboxSandboxProvider) {
  provider.seedForTests({
    hostedSessionId: HOSTED_SESSION,
    hostedSandboxId: HOSTED_SANDBOX,
    localId: LOCAL_IDS.sandbox,
    localProjectId: LOCAL_IDS.project,
    localSessionId: LOCAL_IDS.session,
    spec: testSpec() as never,
  })
}

describe('hosted asynchronous lifecycle', () => {
  it.each([200, 201, 202])(
    'accepts create status %i and waits until the sandbox runs',
    async (status) => {
      let operationPolls = 0
      let sessionPolls = 0
      const { api } = await seededApi(async (input, init) => {
        const url = String(input)
        if (init?.method === 'POST')
          return jsonResponse(
            hostedOperationFixture({
              state: 'pending',
              session: provisioningSession(),
            }),
            status,
          )
        if (url.includes('/operations/'))
          return jsonResponse(
            hostedOperationFixture({
              state: ++operationPolls === 1 ? 'running' : 'succeeded',
            }),
          )
        if (url.includes('/sessions/'))
          return jsonResponse(++sessionPolls === 1 ? provisioningSession() : hostedSessionFixture())
        return jsonResponse({ id: HOSTED_PROJECT })
      })
      const { provider, wait } = providerFor(api)
      const created = await provider.create(operationContext() as never, createRequest as never)
      expect(created.sandbox.lifecycle.normalizedState).toBe('running')
      expect(operationPolls).toBe(2)
      expect(sessionPolls).toBe(2)
      expect(wait.sleeps).toEqual([250, 250])
    },
  )

  it('persists the mapping before the first operation poll, including failed admission', async () => {
    const directory = await mkdtemp(`${tmpdir()}/ocbox-provisioning-`)
    directories.push(directory)
    const store = new LifecycleStore(directory, ProjectIdSchema.parse(LOCAL_IDS.project))
    const { api } = await seededApi(async (input, init) => {
      if (init?.method === 'POST')
        return jsonResponse(
          hostedOperationFixture({
            state: 'pending',
            session: provisioningSession(),
          }),
          202,
        )
      if (String(input).includes('/operations/')) {
        expect(
          (await store.load()).hostedMappings[scope]?.[SandboxIdSchema.parse(LOCAL_IDS.sandbox)],
        ).toMatchObject({
          hostedSandboxId: HOSTED_SANDBOX,
          hostedSessionId: HOSTED_SESSION,
          deleted: false,
        })
        return jsonResponse(
          hostedOperationFixture({
            state: 'failed',
            error: { code: 'admission_closed', message: 'opaque denial' },
          }),
        )
      }
      return jsonResponse({ id: HOSTED_PROJECT })
    })
    const provider = new OcboxSandboxProvider({
      api,
      hostedProjectId: HOSTED_PROJECT,
      mappingScope: async () => 'scope',
      createId: () => LOCAL_IDS.sandbox,
    })
    provider.bindLifecycleStore(store)
    await expect(
      provider.create(operationContext() as never, createRequest as never),
    ).rejects.toMatchObject({ message: ADMISSION_MESSAGES[admissionCode] })
    expect(
      (await store.load()).hostedMappings[scope]?.[SandboxIdSchema.parse(LOCAL_IDS.sandbox)],
    ).toBeDefined()
  })

  it('bounds provisioning even when the operation already succeeded', async () => {
    const { api } = await seededApi(async (input, init) => {
      if (init?.method === 'POST')
        return jsonResponse(
          hostedOperationFixture({
            session: provisioningSession(),
          }),
          202,
        )
      if (String(input).includes('/operations/')) return jsonResponse(hostedOperationFixture())
      if (String(input).includes('/sessions/')) return jsonResponse(provisioningSession())
      return jsonResponse({ id: HOSTED_PROJECT })
    })
    const { provider, wait } = providerFor(api)
    await expect(
      provider.create(operationContext() as never, createRequest as never),
    ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
    expect(wait.sleeps.reduce((sum, value) => sum + value, 0)).toBe(1000)
  })

  it('surfaces a header-only create rate limit with Retry-After', async () => {
    const { api } = await seededApi(async (_input, init) =>
      init?.method === 'POST'
        ? new Response(
            JSON.stringify({
              error: { code: 'RATE_LIMITED', message: 'Try later' },
              requestId: LOCAL_IDS.request,
            }),
            {
              status: 429,
              headers: { 'retry-after': '7', 'x-request-id': LOCAL_IDS.request },
            },
          )
        : jsonResponse({ id: HOSTED_PROJECT }),
    )
    const { provider } = providerFor(api)
    await expect(
      provider.create(operationContext() as never, createRequest as never),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', details: { retryAfterSeconds: 7 } })
  })

  it.each([202, 503])('waits for delayed deletion after destroy status %i', async (status) => {
    let requested = false
    let confirmationPolls = 0
    const { api } = await seededApi(async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST') {
        requested = true
        return status === 202
          ? jsonResponse(hostedOperationFixture({ kind: 'session_destroy' }), status)
          : errorResponse('SERVICE_UNAVAILABLE', status)
      }
      if (url.includes('/operations/'))
        return jsonResponse(hostedOperationFixture({ kind: 'session_destroy' }))
      if (url.includes('/sessions/')) {
        if (!requested) return jsonResponse(hostedSessionFixture())
        return jsonResponse(
          ++confirmationPolls < 3
            ? hostedSessionFixture({ normalizedState: 'destroying', rawState: 'destroying' })
            : hostedSessionFixture({
                normalizedState: 'destroyed',
                rawState: 'destroyed',
                primarySandboxId: null,
                sandboxes: [],
              }),
        )
      }
      return jsonResponse({ id: HOSTED_PROJECT })
    })
    const { provider } = providerFor(api)
    seed(provider)
    const destroyed = await provider.destroy(
      operationContext() as never,
      { sandboxId: LOCAL_IDS.sandbox } as never,
    )
    expect(destroyed.sandbox.lifecycle.normalizedState).toBe('deleted')
    expect(confirmationPolls).toBe(3)
  })

  it('bounds delayed deletion without marking the mapping deleted', async () => {
    let requested = false
    const { api } = await seededApi(async (input, init) => {
      if (init?.method === 'POST') {
        requested = true
        return jsonResponse(hostedOperationFixture({ kind: 'session_destroy' }), 202)
      }
      if (String(input).includes('/operations/')) return jsonResponse(hostedOperationFixture())
      if (String(input).includes('/sessions/'))
        return jsonResponse(
          hostedSessionFixture({
            normalizedState: requested ? 'destroying' : 'running',
          }),
        )
      return jsonResponse({ id: HOSTED_PROJECT })
    })
    const { provider } = providerFor(api)
    seed(provider)
    await expect(
      provider.destroy(operationContext() as never, { sandboxId: LOCAL_IDS.sandbox } as never),
    ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
    expect(
      await provider.get(operationContext() as never, { sandboxId: LOCAL_IDS.sandbox } as never),
    ).not.toBeNull()
  })
})

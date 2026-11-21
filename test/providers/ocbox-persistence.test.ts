import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OperationContextSchema,
  OperationIdSchema,
  ProjectIdSchema,
  SandboxIdSchema,
  SandboxSpecSchema,
  SessionIdSchema,
} from '../../src/contracts.js'
import { LifecycleStore } from '../../src/lifecycle/store.js'
import { OcboxSandboxProvider } from '../../src/providers/ocbox/provider.js'
import {
  errorResponse,
  HOSTED_PROJECT,
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
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function repository() {
  const directory = await mkdtemp(join(tmpdir(), 'ocbox-hosted-persistence-'))
  directories.push(directory)
  return {
    directory,
    store: new LifecycleStore(directory, ProjectIdSchema.parse(LOCAL_IDS.project)),
  }
}

const createRequest = {
  adoption: {
    strategy: 'serialize_then_reconcile' as const,
    metadata: {
      operationId: OperationIdSchema.parse(LOCAL_IDS.operation),
      sessionId: SessionIdSchema.parse(LOCAL_IDS.session),
    },
  },
  projectId: ProjectIdSchema.parse(LOCAL_IDS.project),
  sessionId: SessionIdSchema.parse(LOCAL_IDS.session),
  specification: SandboxSpecSchema.parse(testSpec()),
}

function routes(input: unknown, init?: RequestInit): Promise<Response> {
  const path = new URL(String(input)).pathname
  if (path === `/v1/projects/${HOSTED_PROJECT}`)
    return Promise.resolve(jsonResponse({ id: HOSTED_PROJECT }))
  if (path === `/v1/projects/${HOSTED_PROJECT}/sessions` || path.startsWith('/v1/operations/')) {
    return Promise.resolve(
      jsonResponse(hostedOperationFixture({}), init?.method === 'POST' ? 202 : 200),
    )
  }
  return Promise.resolve(jsonResponse(hostedSessionFixture({})))
}

describe('hosted mapping lifecycle repository', () => {
  it('loads existing lifecycle files and preserves simultaneous lifecycle and hosted mapping writes', async () => {
    const { directory, store } = await repository()
    await store.update((state) => state)
    const path = join(directory, 'lifecycle', `${LOCAL_IDS.project}.json`)
    const legacy = JSON.parse(await readFile(path, 'utf8'))
    delete legacy.hostedMappings
    await writeFile(path, JSON.stringify(legacy))
    expect((await store.load()).hostedMappings).toEqual({})

    const { api } = await seededApi(routes)
    const providers = [LOCAL_IDS.sandbox, '77777777-7777-4777-8777-777777777777'].map((id) => {
      const provider = new OcboxSandboxProvider({
        api,
        hostedProjectId: HOSTED_PROJECT,
        mappingScope: () => Promise.resolve('login-scope'),
        createId: () => id,
      })
      provider.bindLifecycleStore(new LifecycleStore(directory, createRequest.projectId))
      return provider
    })
    await Promise.all([
      ...providers.map((provider) =>
        provider.create(OperationContextSchema.parse(operationContext()), createRequest),
      ),
      ...Array.from({ length: 10 }, () =>
        store.update((state) => ({
          ...state,
          operationAttempts: {
            ...state.operationAttempts,
            [LOCAL_IDS.operation]:
              (state.operationAttempts[OperationIdSchema.parse(LOCAL_IDS.operation)] ?? 0) + 1,
          },
        })),
      ),
    ])
    const state = await store.load()
    expect(Object.keys(state.hostedMappings['login-scope'] ?? {})).toHaveLength(2)
    expect(state.operationAttempts[OperationIdSchema.parse(LOCAL_IDS.operation)]).toBe(10)
    const restarted = new OcboxSandboxProvider({
      api,
      hostedProjectId: HOSTED_PROJECT,
      mappingScope: () => Promise.resolve('login-scope'),
    })
    restarted.bindLifecycleStore(store)
    const observed = await restarted.get(OperationContextSchema.parse(operationContext()), {
      sandboxId: SandboxIdSchema.parse(LOCAL_IDS.sandbox),
    })
    expect(observed?.id).toBe(LOCAL_IDS.sandbox)
  })

  it('persists a mutation 404 as stale and rejects a restarted provider before dispatch', async () => {
    const { store } = await repository()
    let sessionGets = 0
    const { api } = await seededApi((input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/stop')) return Promise.resolve(errorResponse('NOT_FOUND', 404))
      if (path === `/v1/sessions/${HOSTED_SESSION}`) sessionGets += 1
      return routes(input, init)
    })
    const provider = new OcboxSandboxProvider({
      api,
      hostedProjectId: HOSTED_PROJECT,
      mappingScope: () => Promise.resolve('login-scope'),
      createId: () => LOCAL_IDS.sandbox,
    })
    provider.bindLifecycleStore(store)
    const created = await provider.create(
      OperationContextSchema.parse(operationContext()),
      createRequest,
    )
    await expect(
      provider.stop(OperationContextSchema.parse(operationContext()), {
        sandboxId: created.sandbox.id,
      }),
    ).rejects.toMatchObject({
      code: 'SANDBOX_NOT_FOUND',
      providerCode: 'HOSTED_MAPPING_STALE',
    })
    const restarted = new OcboxSandboxProvider({
      api,
      hostedProjectId: HOSTED_PROJECT,
      mappingScope: () => Promise.resolve('login-scope'),
    })
    restarted.bindLifecycleStore(store)
    const before = sessionGets
    await expect(
      restarted.get(OperationContextSchema.parse(operationContext()), {
        sandboxId: created.sandbox.id,
      }),
    ).rejects.toMatchObject({
      providerCode: 'HOSTED_MAPPING_STALE',
    })
    expect(sessionGets).toBe(before)
  })
})

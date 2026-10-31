import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectIdSchema, SandboxIdSchema } from '../../src/contracts.js'
import { LifecycleStore } from '../../src/lifecycle/store.js'
import { OcboxSandboxProvider } from '../../src/providers/ocbox/provider.js'
import {
  errorResponse,
  HOSTED_PROJECT,
  HOSTED_SANDBOX,
  HOSTED_SESSION,
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

async function setup(
  options: {
    state?: string
    foreignSession?: boolean
    foreignSandbox?: boolean
    unknown?: boolean
    stuck?: boolean
    conflict?: boolean
    scope?: string
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'ocbox-cancel-'))
  directories.push(directory)
  const store = new LifecycleStore(directory, ProjectIdSchema.parse(LOCAL_IDS.project))
  await store.update((state) => {
    state.hostedMappings['scope'] = {
      [SandboxIdSchema.parse(LOCAL_IDS.sandbox)]: {
        localId: SandboxIdSchema.parse(LOCAL_IDS.sandbox),
        localSessionId: LOCAL_IDS.session as never,
        localProjectId: state.projectId,
        hostedSessionId: HOSTED_SESSION,
        hostedSandboxId: HOSTED_SANDBOX,
        createdAt: '2026-09-12T10:00:00.000Z',
        updatedAt: '2026-09-12T10:00:00.000Z',
        stale: false,
        deleted: false,
        spec: testSpec() as never,
        lastExecutionId: 'execution',
      },
    }
    return state
  })
  let terminal = options.state ?? 'running'
  let cancels = 0
  const { api } = await seededApi(async (input, init) => {
    const url = String(input)
    if (url.endsWith(`/sessions/${HOSTED_SESSION}`)) return jsonResponse(hostedSessionFixture({}))
    if (url.endsWith(`/sessions/${HOSTED_SESSION}/executions`) && init?.method === 'POST') {
      return jsonResponse(
        {
          id: 'execution',
          createdAt: '2026-09-12T10:00:00.000Z',
          sessionId: HOSTED_SESSION,
          sandboxId: HOSTED_SANDBOX,
        },
        202,
      )
    }
    if (url.includes('/events')) return jsonResponse({ data: [], nextCursor: null })
    if (url.endsWith('/result')) return jsonResponse({ kind: 'cancelled' })
    if (String(input).endsWith('/cancel')) {
      cancels += 1
      if (!options.stuck) terminal = 'cancelled'
      return options.conflict ? errorResponse('CONFLICT', 409) : jsonResponse({}, 202)
    }
    if (options.unknown) return errorResponse('NOT_FOUND', 404)
    return jsonResponse({
      id: 'execution',
      createdAt: '2026-09-12T10:00:00.000Z',
      updatedAt: '2026-09-12T10:00:00.000Z',
      sessionId: options.foreignSession ? 'other' : HOSTED_SESSION,
      sandboxId: options.foreignSandbox ? 'other' : HOSTED_SANDBOX,
      state: terminal,
      command: 'sleep 600',
      exitCode: null,
      failureKind: null,
      failure: null,
      truncated: false,
      outputBytes: 0,
      outputLimitBytes: 1024,
    })
  })
  const provider = new OcboxSandboxProvider({
    api,
    hostedProjectId: HOSTED_PROJECT,
    mappingScope: async () => options.scope ?? 'scope',
  })
  provider.bindLifecycleStore(store)
  return { provider, store, cancels: () => cancels }
}

describe('hosted cancellation from durable mappings', () => {
  const sandboxId = SandboxIdSchema.parse(LOCAL_IDS.sandbox)
  it('persists a started hosted execution and reports external cancellation through its handle', async () => {
    const { provider, store } = await setup()
    await store.update((state) => {
      delete state.hostedMappings['scope']?.[sandboxId]?.lastExecutionId
      return state
    })
    const handle = await provider.exec.execute(operationContext() as never, {
      sandboxId,
      command: { mode: 'argv', argv: ['sleep', '600'] },
      environment: {},
      timeoutMilliseconds: null,
      workingDirectory: null,
    })
    expect((await store.load()).hostedMappings['scope']?.[sandboxId]?.lastExecutionId).toBe(
      'execution',
    )
    await provider.cancelSandboxExecution(sandboxId, undefined, 1000)
    expect(await handle.result).toMatchObject({ cancelled: true, exitCode: 130 })
    expect(
      (await store.load()).hostedMappings['scope']?.[sandboxId]?.lastExecutionId,
    ).toBeUndefined()
  })
  it('does not clear a newer last execution when an older one finishes', async () => {
    const { provider, store } = await setup({ state: 'completed' })
    await store.update((state) => {
      const mapping = state.hostedMappings['scope']?.[sandboxId]
      if (mapping !== undefined) mapping.lastExecutionId = 'newer'
      return state
    })
    await provider.cancelSandboxExecution(sandboxId, 'execution', 1000)
    expect((await store.load()).hostedMappings['scope']?.[sandboxId]?.lastExecutionId).toBe('newer')
  })
  it('cancels the persisted execution and clears the last record', async () => {
    const { provider, store, cancels } = await setup()
    expect(await provider.cancelSandboxExecution(sandboxId, undefined, 1000)).toMatchObject({
      executionId: 'execution',
      state: 'cancelled',
    })
    expect(cancels()).toBe(1)
    expect(
      (await store.load()).hostedMappings['scope']?.[sandboxId]?.lastExecutionId,
    ).toBeUndefined()
    await expect(provider.cancelSandboxExecution(sandboxId, undefined, 1000)).rejects.toMatchObject(
      { code: 'INVALID_STATE', message: 'Nothing running in this Sandbox' },
    )
  })
  it.each(['completed', 'cancelled', 'failed'])(
    'returns an already %s execution without a cancel request',
    async (state) => {
      const { provider, cancels } = await setup({ state })
      expect(await provider.cancelSandboxExecution(sandboxId, 'execution', 1000)).toMatchObject({
        state,
      })
      expect(cancels()).toBe(0)
    },
  )
  it.each([{ foreignSession: true }, { foreignSandbox: true }])(
    'rejects execution ownership mismatches: %j',
    async (options) => {
      const { provider, cancels } = await setup(options)
      await expect(
        provider.cancelSandboxExecution(sandboxId, 'execution', 1000),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' })
      expect(cancels()).toBe(0)
    },
  )
  it('cannot access another mapping scope', async () => {
    const { provider, cancels } = await setup({ scope: 'other' })
    await expect(
      provider.cancelSandboxExecution(sandboxId, 'execution', 1000),
    ).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' })
    expect(cancels()).toBe(0)
  })
  it('reports an unknown ID', async () => {
    const { provider } = await setup({ unknown: true })
    await expect(provider.cancelSandboxExecution(sandboxId, 'unknown', 1000)).rejects.toMatchObject(
      { code: 'SANDBOX_NOT_FOUND', message: 'Unknown execution ID: unknown' },
    )
  })
  it('bounds the terminal wait and retains the running record', async () => {
    const { provider, store } = await setup({ stuck: true })
    await expect(provider.cancelSandboxExecution(sandboxId, undefined, 20)).rejects.toMatchObject({
      code: 'OPERATION_TIMEOUT',
    })
    expect((await store.load()).hostedMappings['scope']?.[sandboxId]?.lastExecutionId).toBe(
      'execution',
    )
  })
  it('handles completion racing the cancel request', async () => {
    const { provider } = await setup({ conflict: true })
    expect(await provider.cancelSandboxExecution(sandboxId, undefined, 1000)).toMatchObject({
      state: 'cancelled',
    })
  })
})

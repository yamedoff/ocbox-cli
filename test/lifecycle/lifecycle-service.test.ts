import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProjectIdSchema,
  RequestIdSchema,
  UtcTimestampSchema,
  type ProviderCapabilities,
} from '../../src/contracts.js'
import { DEFAULT_PROJECT_CONFIG } from '../../src/cli/runtime.js'
import { parseProjectConfig } from '../../src/config/index.js'
import { OcboxError } from '../../src/errors/index.js'
import { LifecycleService, LifecycleStore } from '../../src/lifecycle/index.js'
import {
  FAKE_CAPABILITIES,
  FakeSandboxProvider,
  type FakeProviderFaults,
} from '../../src/providers/fake/index.js'
import { ProviderRegistry } from '../../src/providers/index.js'

const PROJECT_ID = ProjectIdSchema.parse('11111111-1111-4111-8111-111111111111')
const CONFIG = parseProjectConfig(DEFAULT_PROJECT_CONFIG)
const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ocbox-lifecycle-'))
  temporaryDirectories.push(directory)
  return directory
}

function createService(
  stateDirectory: string,
  options: {
    readonly faults?: FakeProviderFaults
    readonly capabilities?: ProviderCapabilities
    readonly signal?: AbortSignal
    readonly now?: () => Date
  } = {},
): LifecycleService {
  const now = options.now ?? (() => new Date())
  const registry = new ProviderRegistry().register(
    'fake',
    () =>
      new FakeSandboxProvider(stateDirectory, {
        now,
        ...(options.faults === undefined ? {} : { faults: options.faults }),
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
  )
  return new LifecycleService({
    config: CONFIG,
    projectId: PROJECT_ID,
    store: new LifecycleStore(stateDirectory, PROJECT_ID),
    registry,
    now,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
}

async function waitForOperation(stateDirectory: string): Promise<void> {
  const store = new LifecycleStore(stateDirectory, PROJECT_ID)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await store.load()
    const selected =
      state.activeSessionId === null ? undefined : state.sessions[state.activeSessionId]
    if (selected?.currentOperationId !== null && selected?.state !== 'active') return
    await delay(2)
  }
  throw new Error('Timed out waiting for lifecycle operation reservation')
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('LifecycleService', () => {
  it('persists the complete lifecycle on one primary binding', async () => {
    const directory = await temporaryDirectory()
    const service = createService(directory)

    const created = await service.start()
    const sessionId = created.session.id
    const sandboxId = created.sandbox?.id
    expect(created.session.state).toBe('active')
    expect(created.session.bindings).toHaveLength(1)
    expect(created.sandbox?.specification.effective).toEqual(
      created.sandbox?.specification.requested,
    )

    const refreshed = await createService(directory).start()
    expect(refreshed.session.id).toBe(sessionId)
    expect(refreshed.sandbox?.id).toBe(sandboxId)

    const paused = await createService(directory).pause()
    expect(paused.session.state).toBe('paused')
    expect(paused.sandbox?.id).toBe(sandboxId)

    const resumed = await createService(directory).start()
    expect(resumed.session.state).toBe('active')
    expect(resumed.sandbox?.id).toBe(sandboxId)

    const stopped = await createService(directory).stop()
    expect(stopped.session.state).toBe('stopped')
    expect(stopped.sandbox?.id).toBe(sandboxId)

    const restarted = await createService(directory).start()
    expect(restarted.session.state).toBe('active')
    expect(restarted.sandbox?.id).toBe(sandboxId)

    const destroyed = await createService(directory).destroy()
    expect(destroyed.session.state).toBe('destroyed')
    expect(destroyed.session.bindings[0]?.releasedAt).not.toBeNull()
    expect(destroyed.sandbox).toBeNull()
    expect((await createService(directory).destroy()).session.state).toBe('destroyed')
    await expect(createService(directory).start()).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('creates and selects a distinct Session for every explicit start --new', async () => {
    const directory = await temporaryDirectory()
    const first = await createService(directory).start()
    const second = await createService(directory).start(true)
    const listed = await createService(directory).list()

    expect(second.session.id).not.toBe(first.session.id)
    expect(second.sandbox?.id).not.toBe(first.sandbox?.id)
    expect(listed).toHaveLength(2)
    expect(listed.filter((view) => view.selected).map((view) => view.session.id)).toEqual([
      second.session.id,
    ])
  })

  it('adopts exactly one Sandbox after a lost create response', async () => {
    const directory = await temporaryDirectory()
    await expect(
      createService(directory, { faults: { lostResponseActions: ['create'] } }).start(true),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' })

    const recovered = await createService(directory).start()
    expect(recovered.session.state).toBe('active')
    expect(recovered.operation).toBeNull()

    const state = await new LifecycleStore(directory, PROJECT_ID).load()
    const createOperation = Object.values(state.operations).find(
      (operation) => operation.action === 'create',
    )
    expect(createOperation?.idempotencyResolution?.kind).toBe('adopted_existing')

    const provider = new FakeSandboxProvider(directory)
    const resources = await provider.list(
      {
        requestId: RequestIdSchema.parse('22222222-2222-4222-8222-222222222222'),
        issuedAt: UtcTimestampSchema.parse('2026-09-09T12:30:00.000Z'),
      },
      { projectId: PROJECT_ID, sessionId: recovered.session.id },
    )
    expect(resources).toHaveLength(1)
  })

  it('returns OPERATION_CONFLICT for a different concurrent mutation', async () => {
    const directory = await temporaryDirectory()
    await createService(directory).start()
    const pause = createService(directory, {
      faults: { delayMilliseconds: { pause: 100 } },
    }).pause()
    await waitForOperation(directory)

    await expect(createService(directory).stop()).rejects.toMatchObject({
      code: 'OPERATION_CONFLICT',
    })
    expect((await pause).session.state).toBe('paused')
  })

  it('gates pause before provider mutation when memory preservation is unsupported', async () => {
    const directory = await temporaryDirectory()
    const created = await createService(directory).start()
    const capabilities: ProviderCapabilities = {
      ...FAKE_CAPABILITIES,
      lifecycle: { ...FAKE_CAPABILITIES.lifecycle, supportsMemoryPause: false },
    }

    await expect(createService(directory, { capabilities }).pause()).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    })
    const state = await new LifecycleStore(directory, PROJECT_ID).load()
    expect(state.sessions[created.session.id]?.state).toBe('active')
    expect(state.sessions[created.session.id]?.currentOperationId).toBeNull()
  })

  it('retains a failed unbound Session and never silently replaces it', async () => {
    const directory = await temporaryDirectory()
    await expect(
      createService(directory, { faults: { failures: { create: 'PROVIDER_CAPACITY' } } }).start(),
    ).rejects.toMatchObject({ code: 'PROVIDER_CAPACITY' })

    const state = await new LifecycleStore(directory, PROJECT_ID).load()
    const failed =
      state.activeSessionId === null ? undefined : state.sessions[state.activeSessionId]
    expect(failed).toMatchObject({ state: 'error', bindings: [], currentOperationId: null })
    await expect(createService(directory).start()).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('preserves an unexpected raw provider state and fails safely', async () => {
    const directory = await temporaryDirectory()
    const created = await createService(directory).start()
    if (created.sandbox === null) throw new Error('Expected created Sandbox')
    await new FakeSandboxProvider(directory).setRawState(
      created.sandbox.id,
      'unknown',
      'fake:UNRECOGNIZED_42',
    )

    await expect(createService(directory).start()).rejects.toMatchObject({ code: 'INVALID_STATE' })
    const inspected = await createService(directory).status()
    expect(inspected.session.state).toBe('error')
    expect(inspected.sandbox?.lifecycle).toMatchObject({
      normalizedState: 'unknown',
      rawState: 'fake:UNRECOGNIZED_42',
    })
  })

  it('keeps an interrupted Operation resumable with the same idempotency key', async () => {
    const directory = await temporaryDirectory()
    await createService(directory).start()
    const controller = new AbortController()
    const pending = createService(directory, {
      faults: { delayMilliseconds: { pause: 250 } },
      signal: controller.signal,
    }).pause()
    await waitForOperation(directory)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })

    const state = await new LifecycleStore(directory, PROJECT_ID).load()
    const selected =
      state.activeSessionId === null ? undefined : state.sessions[state.activeSessionId]
    expect(selected?.state).toBe('pausing')
    const operationId = selected?.currentOperationId

    const reconciled = await createService(directory).pause()
    expect(reconciled.session.state).toBe('paused')
    const finalState = await new LifecycleStore(directory, PROJECT_ID).load()
    expect(operationId).toBeDefined()
    if (operationId === null || operationId === undefined) {
      throw new Error('Expected a reserved lifecycle Operation')
    }
    expect(finalState.operations[operationId]?.status).toBe('succeeded')
  })

  it('returns typed registry errors for unknown and unavailable providers', async () => {
    const registry = new ProviderRegistry()
    expect(() => registry.resolve('missing')).toThrowError(OcboxError)
    expect(() => registry.resolve('missing')).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    )

    registry.register('offline', () => {
      throw new Error('not configured')
    })
    expect(() => registry.resolve('offline')).toThrow(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
    )
  })
})

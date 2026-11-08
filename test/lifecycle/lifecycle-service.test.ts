import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROJECT_CONFIG } from '../../src/cli/runtime.js'
import { sessionViewLine } from '../../src/cli/views.js'
import { parseProjectConfig } from '../../src/config/index.js'
import {
  type CreateSandboxRequest,
  type LifecycleMutationRequest,
  type OperationContext,
  ProjectIdSchema,
  type ProviderCapabilities,
  RequestIdSchema,
  type Sandbox,
  SandboxIdSchema,
  type SandboxMutationResult,
  SandboxMutationResultSchema,
  SandboxSchema,
  UtcTimestampSchema,
} from '../../src/contracts.js'
import { OcboxError } from '../../src/errors/index.js'

const INVALID_SESSION_ID_MESSAGE = 'Session ID must be a UUID or ULID; run `ocbox ls` to copy one.'
import { LifecycleService, LifecycleStore } from '../../src/lifecycle/index.js'
import {
  FAKE_CAPABILITIES,
  type FakeProviderFaults,
  FakeSandboxProvider,
} from '../../src/providers/fake/index.js'
import { ProviderRegistry } from '../../src/providers/index.js'

const PROJECT_ID = ProjectIdSchema.parse('11111111-1111-4111-8111-111111111111')
const CONFIG = parseProjectConfig(DEFAULT_PROJECT_CONFIG)
const MAPPING_SANDBOX = SandboxIdSchema.parse('77777777-7777-4777-8777-777777777777')
const HOSTED_SANDBOX = 'sbx_review_hosted'
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
    readonly provider?: FakeSandboxProvider
  } = {},
): LifecycleService {
  const now = options.now ?? (() => new Date())
  const registry = new ProviderRegistry().register(
    'fake',
    () =>
      options.provider ??
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

class FailedStartHostedProvider extends FakeSandboxProvider {
  readonly destroyCalls: string[] = []
  readonly hostedSessionId = 'sess_review_hosted'
  readonly #store: LifecycleStore
  readonly #mode: 'timeout' | 'missing-binding'
  #sessionId: CreateSandboxRequest['sessionId'] | undefined
  #spec: CreateSandboxRequest['specification'] | undefined

  constructor(stateDirectory: string, store: LifecycleStore, mode: 'timeout' | 'missing-binding') {
    super(stateDirectory)
    this.#store = store
    this.#mode = mode
  }

  override async create(
    context: OperationContext,
    request: CreateSandboxRequest,
  ): Promise<SandboxMutationResult> {
    this.#sessionId = request.sessionId
    this.#spec = request.specification
    const now = new Date().toISOString()
    await this.#store.update((state) => {
      state.hostedMappings['test-scope'] = {
        ...state.hostedMappings['test-scope'],
        [MAPPING_SANDBOX]: {
          localId: MAPPING_SANDBOX,
          localSessionId: request.sessionId,
          localProjectId: request.projectId,
          hostedSessionId: this.hostedSessionId,
          hostedSandboxId: HOSTED_SANDBOX,
          spec: request.specification,
          createdAt: now,
          updatedAt: now,
          stale: false,
          deleted: false,
        },
      }
      return state
    })
    if (this.#mode === 'timeout') {
      throw new OcboxError({
        code: 'PROVIDER_TIMEOUT',
        message: 'The hosted box did not start in time',
        requestId: context.requestId,
      })
    }
    throw new OcboxError({
      code: 'INVALID_STATE',
      message: 'The hosted session has no active primary sandbox binding',
      providerCode: 'MISSING_PRIMARY_BINDING',
      requestId: context.requestId,
    })
  }

  override async destroy(
    context: OperationContext,
    request: LifecycleMutationRequest,
  ): Promise<SandboxMutationResult> {
    this.destroyCalls.push(request.sandboxId)
    const now = new Date().toISOString()
    if (this.#sessionId === undefined || this.#spec === undefined) {
      throw new TypeError('The test provider has not created a hosted Session')
    }
    const sandbox = SandboxSchema.parse({
      id: request.sandboxId,
      projectId: PROJECT_ID,
      providerSandboxId: HOSTED_SANDBOX,
      provider: 'fake',
      lifecycle: {
        normalizedState: 'deleted',
        rawState: 'deleted',
        desiredState: 'deleted',
        reason: null,
        observedAt: now,
        lifecycleTimestamps: {
          creationStartedAt: null,
          runningAt: null,
          pauseStartedAt: null,
          pausedAt: null,
          stopStartedAt: null,
          stoppedAt: null,
          deletionStartedAt: now,
          deletedAt: now,
          errorAt: null,
          lastTransitionAt: now,
        },
      },
      specification: {
        requested: this.#spec,
        effective: this.#spec,
        effectiveObservedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    })
    return SandboxMutationResultSchema.parse({
      operation: {
        id: context.operationId,
        requestId: context.requestId,
        sessionId: this.#sessionId,
        sandboxId: request.sandboxId,
        action: 'destroy',
        status: 'succeeded',
        idempotencyKey: context.idempotencyKey,
        idempotencyResolution: { kind: 'created' },
        providerVerifiedAt: now,
        createdAt: context.issuedAt,
        startedAt: context.issuedAt,
        completedAt: now,
      },
      sandbox,
    })
  }

  override async get(): Promise<Sandbox | null> {
    return null
  }
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
    expect((await createService(directory).destroy(destroyed.session.id)).session.state).toBe(
      'destroyed',
    )
    const startedAgain = await createService(directory).start()
    expect(startedAgain.session.state).toBe('active')
    expect(startedAgain.session.id).not.toBe(destroyed.session.id)
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
    const provider = new FakeSandboxProvider(directory)
    const originalPause = provider.pause.bind(provider)
    let releasePause = () => {}
    let enteredPause = () => {}
    const entered = new Promise<void>((resolve) => {
      enteredPause = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releasePause = resolve
    })
    // Hold the provider mutation until the conflicting command has observed the
    // reservation. A wall-clock delay can expire before Windows finishes I/O.
    vi.spyOn(provider, 'pause').mockImplementation(async (...args) => {
      enteredPause()
      await gate
      return originalPause(...args)
    })
    const pause = createService(directory, { provider }).pause()
    try {
      await entered
      await expect(createService(directory).stop()).rejects.toMatchObject({
        code: 'OPERATION_CONFLICT',
      })
    } finally {
      releasePause()
    }
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

  it('labels every field on the Session view line', async () => {
    const directory = await temporaryDirectory()
    const view = await createService(directory).start()

    expect(sessionViewLine(view)).toBe(
      `* session=${view.session.id} state=active project=${PROJECT_ID} provider=running raw=fake:RUNNING`,
    )
  })

  it('hides destroyed Sessions from list unless they are requested', async () => {
    const directory = await temporaryDirectory()
    const first = await createService(directory).start()
    const second = await createService(directory).start(true)
    await createService(directory).destroy(first.session.id)

    const visible = await createService(directory).list()
    expect(visible.map((view) => view.session.id)).toEqual([second.session.id])

    const all = await createService(directory).list(true)
    expect(all.map((view) => view.session.id)).toEqual([first.session.id, second.session.id])
    expect(all[0]?.session.state).toBe('destroyed')
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

  it('answers a malformed Session ID with INVALID_SPEC in use, status, and stop', async () => {
    const directory = await temporaryDirectory()
    await createService(directory).start()
    const expected = {
      code: 'INVALID_SPEC',
      message: INVALID_SESSION_ID_MESSAGE,
    }

    await expect(createService(directory).use('ses_nope')).rejects.toMatchObject(expected)
    await expect(createService(directory).status('ses_nope')).rejects.toMatchObject(expected)
    await expect(createService(directory).stop('ses_nope')).rejects.toMatchObject(expected)
  })

  it('names ocbox start when exec targets a stopped Session', async () => {
    const directory = await temporaryDirectory()
    await createService(directory).start()
    await createService(directory).stop()

    await expect(createService(directory).executionTarget()).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: expect.stringContaining('run `ocbox start` to resume it.'),
    })
  })

  it('uses SANDBOX_NOT_FOUND and names ocbox ls for a missing Session', async () => {
    const directory = await temporaryDirectory()
    await createService(directory).start()

    await expect(
      createService(directory).executionTarget('99999999-9999-4999-8999-999999999999'),
    ).rejects.toMatchObject({
      code: 'SANDBOX_NOT_FOUND',
      message: expect.stringContaining('run `ocbox ls` to list Sessions.'),
    })
  })

  it('destroys the hosted Session after a double PROVIDER_TIMEOUT start', async () => {
    const directory = await temporaryDirectory()
    const store = new LifecycleStore(directory, PROJECT_ID)
    const provider = new FailedStartHostedProvider(directory, store, 'timeout')

    await expect(createService(directory, { provider }).start()).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    })
    await expect(createService(directory, { provider }).start()).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    })

    const failed = await store.load()
    const sessionId = failed.activeSessionId
    if (sessionId === null) throw new Error('Expected a selected Session')
    expect(failed.sessions[sessionId]).toMatchObject({ state: 'creating', bindings: [] })
    expect(failed.sessions[sessionId]?.currentOperationId).not.toBeNull()

    const destroyed = await createService(directory, { provider }).destroy(sessionId)
    expect(destroyed.session.state).toBe('destroyed')
    expect(destroyed.destroyOutcome).toBe('hosted')
    expect(provider.destroyCalls).toEqual([MAPPING_SANDBOX])
  })

  it('destroys the hosted Session when start leaves state=error with no binding', async () => {
    const directory = await temporaryDirectory()
    const store = new LifecycleStore(directory, PROJECT_ID)
    const provider = new FailedStartHostedProvider(directory, store, 'missing-binding')

    await expect(createService(directory, { provider }).start()).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })

    const failed = await store.load()
    const sessionId = failed.activeSessionId
    if (sessionId === null) throw new Error('Expected a selected Session')
    expect(failed.sessions[sessionId]).toMatchObject({
      state: 'error',
      bindings: [],
      currentOperationId: null,
    })

    const destroyed = await createService(directory, { provider }).destroy(sessionId)
    expect(destroyed.session.state).toBe('destroyed')
    expect(destroyed.destroyOutcome).toBe('hosted')
    expect(provider.destroyCalls).toEqual([MAPPING_SANDBOX])
  })

  it('removes a Session locally when it has no hosted id', async () => {
    const directory = await temporaryDirectory()
    const provider = new FakeSandboxProvider(directory, {
      faults: { failures: { create: 'INVALID_STATE' } },
    })
    const destroy = vi.spyOn(provider, 'destroy')

    await expect(createService(directory, { provider }).start()).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    const failed = await new LifecycleStore(directory, PROJECT_ID).load()
    const sessionId = failed.activeSessionId
    if (sessionId === null) throw new Error('Expected a selected Session')
    expect(failed.sessions[sessionId]).toMatchObject({ state: 'error', bindings: [] })

    const destroyed = await createService(directory, { provider }).destroy(sessionId)
    expect(destroyed.session.state).toBe('destroyed')
    expect(destroyed.destroyOutcome).toBe('local')
    expect(destroy).not.toHaveBeenCalled()
  })
})

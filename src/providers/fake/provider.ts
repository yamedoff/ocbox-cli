import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  ApplySourceRequest,
  ApplySourceResult,
  CancelExecutionRequest,
  ChecksumFileRequest,
  CreatePreviewRequest,
  CreateSandboxRequest,
  ExecHandle,
  ExecRequest,
  FileChecksum,
  FileEntry,
  FileMutationResult,
  GetSandboxRequest,
  LifecycleMutationRequest,
  ListFilesRequest,
  ListSandboxesRequest,
  MakeDirectoryRequest,
  MoveFileRequest,
  Operation,
  OperationAction,
  OperationContext,
  Preview,
  ProviderCapabilities,
  ProviderFiles,
  ProviderLifecycleState,
  ProviderPreviews,
  ProviderSource,
  ReadFileRequest,
  ReadFileResult,
  RemoveFileRequest,
  RequestContext,
  RevokePreviewRequest,
  Sandbox,
  SandboxMutationResult,
  SandboxProvider,
  StatFileRequest,
  WriteFileRequest,
} from '../../contracts.js'
import {
  OperationSchema,
  ProviderSandboxIdSchema,
  RequestIdSchema,
  SandboxIdSchema,
  SandboxMutationResultSchema,
  SandboxSchema,
} from '../../contracts.js'
import type { OcboxErrorCode } from '../../errors/index.js'
import { OcboxError } from '../../errors/index.js'
import { FakeProviderExecution } from '../../execution/fake-provider-execution.js'
import { AtomicJsonStore } from '../../lifecycle/atomic-json-store.js'
import {
  EMPTY_FAKE_PROVIDER_STATE,
  FakeProviderStateSchema,
  type FakeProviderResource,
  type FakeProviderState,
} from './schema.js'

const FAKE_CAPABILITIES: ProviderCapabilities = {
  runtimeClasses: ['container'],
  lifecycle: {
    preservesFilesystemOnStop: true,
    supportsMemoryPause: true,
    supportsArchive: false,
  },
  execution: { streaming: true, cancellation: true },
  files: {
    read: false,
    write: false,
    list: false,
    stat: false,
    makeDirectory: false,
    remove: false,
    move: false,
    checksum: false,
  },
  previews: { supported: false, authenticated: false, http: false, websocket: false },
  egressModes: ['open', 'restricted', 'blocked'],
  metadataSearch: true,
  secretExposureModes: ['unsupported'],
  limits: {
    maxCpuMillicores: null,
    maxMemoryBytes: null,
    maxDiskBytes: null,
    maxExecutionMilliseconds: null,
    maxFileBytes: null,
    maxConcurrentExecutions: null,
    maxSandboxes: null,
    maxSandboxesPerSession: 1,
  },
}

export interface FakeProviderFaults {
  readonly delayMilliseconds?: Partial<Record<OperationAction, number>>
  readonly failures?: Partial<Record<OperationAction, OcboxErrorCode>>
  readonly lostResponseActions?: readonly OperationAction[]
}

export interface FakeProviderOptions {
  readonly now?: () => Date
  readonly createId?: () => string
  readonly faults?: FakeProviderFaults
  readonly signal?: AbortSignal
  readonly capabilities?: ProviderCapabilities
}

function timestamps(previous?: Sandbox['lifecycle']['lifecycleTimestamps']) {
  return (
    previous ?? {
      creationStartedAt: null,
      runningAt: null,
      pauseStartedAt: null,
      pausedAt: null,
      stopStartedAt: null,
      stoppedAt: null,
      deletionStartedAt: null,
      deletedAt: null,
      errorAt: null,
      lastTransitionAt: null,
    }
  )
}

/**
 * Deterministic provider adapter whose resource ledger is intentionally
 * separate from CLI state. This models recovery after an ambiguous response.
 */
export class FakeSandboxProvider implements SandboxProvider {
  readonly name = 'fake'
  readonly #store: AtomicJsonStore<FakeProviderState>
  readonly #now: () => Date
  readonly #createId: () => string
  readonly #faults: FakeProviderFaults
  readonly #signal: AbortSignal | undefined
  readonly #capabilities: ProviderCapabilities
  readonly #execution: FakeProviderExecution

  constructor(stateDirectory: string, options: FakeProviderOptions = {}) {
    this.#store = new AtomicJsonStore(
      join(stateDirectory, 'providers', 'fake.json'),
      FakeProviderStateSchema,
    )
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? randomUUID
    this.#faults = options.faults ?? {}
    this.#signal = options.signal
    this.#capabilities = options.capabilities ?? FAKE_CAPABILITIES
    // The execution port is backed by the host-local contract harness. It models
    // process semantics only; it is not sandbox isolation and is never presented
    // to users as a real provider.
    this.#execution = new FakeProviderExecution({
      now: this.#now,
      createId: this.#createId,
      sessionIdForSandbox: (sandboxId) => this.#sessionIdForSandbox(sandboxId),
    })
  }

  readonly exec = {
    execute: (context: OperationContext, request: ExecRequest): Promise<ExecHandle> =>
      this.#execution.execute(context, request),
    cancel: (context: OperationContext, request: CancelExecutionRequest): Promise<Operation> =>
      this.#execution.cancel(context, request),
  }

  async #sessionIdForSandbox(sandboxId: Sandbox['id']) {
    const state = (await this.#store.load()) ?? EMPTY_FAKE_PROVIDER_STATE
    const entry = Object.values(state.resources).find(
      (candidate) => candidate.sandbox.id === sandboxId,
    )
    if (entry === undefined) {
      throw new OcboxError({
        code: 'SANDBOX_NOT_FOUND',
        message: 'Fake provider sandbox was not found',
        requestId: RequestIdSchema.parse(this.#createId()),
      })
    }
    return entry.sessionId
  }

  readonly files: ProviderFiles = {
    read: (context: RequestContext, _request: ReadFileRequest): Promise<ReadFileResult> =>
      this.#unsupported(context.requestId, 'files_read'),
    write: (context: OperationContext, _request: WriteFileRequest): Promise<FileMutationResult> =>
      this.#unsupported(context.requestId, 'files_write'),
    list: (context: RequestContext, _request: ListFilesRequest): Promise<readonly FileEntry[]> =>
      this.#unsupported(context.requestId, 'files_list'),
    stat: (context: RequestContext, _request: StatFileRequest): Promise<FileEntry | null> =>
      this.#unsupported(context.requestId, 'files_stat'),
    checksum: (context: RequestContext, _request: ChecksumFileRequest): Promise<FileChecksum> =>
      this.#unsupported(context.requestId, 'files_checksum'),
    makeDirectory: (
      context: OperationContext,
      _request: MakeDirectoryRequest,
    ): Promise<FileMutationResult> => this.#unsupported(context.requestId, 'files_make_directory'),
    remove: (context: OperationContext, _request: RemoveFileRequest): Promise<Operation> =>
      this.#unsupported(context.requestId, 'files_remove'),
    move: (context: OperationContext, _request: MoveFileRequest): Promise<FileMutationResult> =>
      this.#unsupported(context.requestId, 'files_move'),
  }

  readonly source: ProviderSource = {
    apply: (context: OperationContext, _request: ApplySourceRequest): Promise<ApplySourceResult> =>
      this.#unsupported(context.requestId, 'source_apply'),
  }

  readonly previews: ProviderPreviews = {
    create: (context: OperationContext, _request: CreatePreviewRequest): Promise<Preview> =>
      this.#unsupported(context.requestId, 'preview'),
    revoke: (context: OperationContext, _request: RevokePreviewRequest): Promise<Operation> =>
      this.#unsupported(context.requestId, 'preview'),
  }

  capabilities(_context: RequestContext): Promise<ProviderCapabilities> {
    return Promise.resolve(this.#capabilities)
  }

  async create(
    context: OperationContext,
    request: CreateSandboxRequest,
  ): Promise<SandboxMutationResult> {
    await this.#before('create', context)
    let result: SandboxMutationResult | undefined
    let loseResponse = false
    await this.#store.update(
      () => structuredClone(EMPTY_FAKE_PROVIDER_STATE),
      (state) => {
        const existingId =
          state.idempotency[context.idempotencyKey] ??
          Object.values(state.resources).find(
            (entry) =>
              entry.sessionId === request.sessionId &&
              entry.createOperationId === request.adoption.metadata.operationId &&
              entry.sandbox.lifecycle.normalizedState !== 'deleted',
          )?.sandbox.providerSandboxId
        if (existingId !== undefined) {
          const existing = state.resources[existingId]
          if (existing === undefined) throw new TypeError('Fake provider index is inconsistent')
          const sandbox = this.#observe(existing.sandbox)
          result = this.#result(context, request.sessionId, 'create', sandbox, {
            kind: 'adopted_existing',
            providerSandboxId: sandbox.providerSandboxId,
            originalOperationId: existing.createOperationId,
          })
          return state
        }

        const now = this.#now().toISOString()
        const providerSandboxId = ProviderSandboxIdSchema.parse(`fake-${this.#createId()}`)
        const sandbox = SandboxSchema.parse({
          id: SandboxIdSchema.parse(this.#createId()),
          projectId: request.projectId,
          providerSandboxId,
          provider: this.name,
          lifecycle: {
            normalizedState: 'running',
            rawState: 'fake:RUNNING',
            desiredState: 'running',
            reason: null,
            observedAt: now,
            lifecycleTimestamps: {
              ...timestamps(),
              creationStartedAt: now,
              runningAt: now,
              lastTransitionAt: now,
            },
          },
          specification: {
            requested: request.specification,
            effective: request.specification,
            effectiveObservedAt: now,
          },
          createdAt: now,
          updatedAt: now,
        })
        state.resources[providerSandboxId] = {
          sandbox,
          sessionId: request.sessionId,
          createOperationId: context.operationId,
          lastOperationId: context.operationId,
        }
        state.idempotency[context.idempotencyKey] = providerSandboxId
        const lostKey = `${context.operationId}:create`
        if (
          this.#faults.lostResponseActions?.includes('create') === true &&
          state.consumedLostResponses[lostKey] !== true
        ) {
          state.consumedLostResponses[lostKey] = true
          loseResponse = true
        }
        result = this.#result(context, request.sessionId, 'create', sandbox, { kind: 'created' })
        return state
      },
    )
    if (loseResponse) {
      throw new OcboxError({
        code: 'PROVIDER_TIMEOUT',
        message: 'Fake provider intentionally lost the create response',
        requestId: context.requestId,
        providerCode: 'FAKE_LOST_RESPONSE',
      })
    }
    if (result === undefined) throw new TypeError('Fake create did not produce a result')
    return SandboxMutationResultSchema.parse(result)
  }

  async get(_context: RequestContext, request: GetSandboxRequest): Promise<Sandbox | null> {
    const state = (await this.#store.load()) ?? EMPTY_FAKE_PROVIDER_STATE
    const entry = Object.values(state.resources).find(
      (candidate) => candidate.sandbox.id === request.sandboxId,
    )
    if (entry === undefined || entry.sandbox.lifecycle.normalizedState === 'deleted') return null
    return this.#observe(entry.sandbox)
  }

  async list(_context: RequestContext, request: ListSandboxesRequest): Promise<readonly Sandbox[]> {
    const state = (await this.#store.load()) ?? EMPTY_FAKE_PROVIDER_STATE
    return Object.values(state.resources)
      .filter(
        (entry) =>
          entry.sandbox.lifecycle.normalizedState !== 'deleted' &&
          (request.projectId === null || entry.sandbox.projectId === request.projectId) &&
          (request.sessionId === null || entry.sessionId === request.sessionId),
      )
      .map((entry) => this.#observe(entry.sandbox))
  }

  start(context: OperationContext, request: LifecycleMutationRequest) {
    return this.#mutate(context, request, 'start', 'running', 'fake:RUNNING')
  }

  pause(context: OperationContext, request: LifecycleMutationRequest) {
    return this.#mutate(context, request, 'pause', 'paused', 'fake:PAUSED')
  }

  resume(context: OperationContext, request: LifecycleMutationRequest) {
    return this.#mutate(context, request, 'resume', 'running', 'fake:RUNNING')
  }

  stop(context: OperationContext, request: LifecycleMutationRequest) {
    return this.#mutate(context, request, 'stop', 'stopped', 'fake:STOPPED')
  }

  destroy(context: OperationContext, request: LifecycleMutationRequest) {
    return this.#mutate(context, request, 'destroy', 'deleted', 'fake:DELETED')
  }

  /** Test-only provider control that verifies raw-state preservation. */
  async setRawState(
    sandboxId: Sandbox['id'],
    normalizedState: ProviderLifecycleState,
    raw: string,
  ) {
    await this.#store.update(
      () => structuredClone(EMPTY_FAKE_PROVIDER_STATE),
      (state) => {
        const entry = Object.values(state.resources).find(
          (candidate) => candidate.sandbox.id === sandboxId,
        )
        if (entry === undefined) throw new TypeError('Unknown fake sandbox')
        const now = this.#now().toISOString()
        entry.sandbox = SandboxSchema.parse({
          ...entry.sandbox,
          lifecycle: {
            ...entry.sandbox.lifecycle,
            normalizedState,
            rawState: raw,
            observedAt: now,
          },
          updatedAt: now,
        })
        return state
      },
    )
  }

  async #mutate(
    context: OperationContext,
    request: LifecycleMutationRequest,
    action: Extract<OperationAction, 'start' | 'pause' | 'resume' | 'stop' | 'destroy'>,
    target: Extract<ProviderLifecycleState, 'running' | 'paused' | 'stopped' | 'deleted'>,
    rawState: string,
  ): Promise<SandboxMutationResult> {
    await this.#before(action, context)
    let result: SandboxMutationResult | undefined
    let loseResponse = false
    await this.#store.update(
      () => structuredClone(EMPTY_FAKE_PROVIDER_STATE),
      (state) => {
        const replayId = state.idempotency[context.idempotencyKey]
        if (replayId !== undefined) {
          const replay = state.resources[replayId]
          if (replay === undefined) throw new TypeError('Fake provider index is inconsistent')
          const sandbox = this.#observe(replay.sandbox)
          result = this.#result(context, replay.sessionId, action, sandbox, {
            kind: 'replayed_result',
            originalOperationId: replay.lastOperationId,
          })
          return state
        }
        const entry = Object.values(state.resources).find(
          (candidate) => candidate.sandbox.id === request.sandboxId,
        )
        if (entry === undefined) {
          throw new OcboxError({
            code: 'SANDBOX_NOT_FOUND',
            message: 'Fake provider sandbox was not found',
            requestId: context.requestId,
          })
        }
        if (entry.sandbox.lifecycle.normalizedState === 'deleted' && action !== 'destroy') {
          throw new OcboxError({
            code: 'INVALID_STATE',
            message: 'Deleted sandbox cannot transition',
            requestId: context.requestId,
          })
        }
        const sandbox = this.#transition(entry, context, target, rawState)
        state.idempotency[context.idempotencyKey] = sandbox.providerSandboxId
        const lostKey = `${context.operationId}:${action}`
        if (
          this.#faults.lostResponseActions?.includes(action) === true &&
          state.consumedLostResponses[lostKey] !== true
        ) {
          state.consumedLostResponses[lostKey] = true
          loseResponse = true
        }
        result = this.#result(context, entry.sessionId, action, sandbox, { kind: 'created' })
        return state
      },
    )
    if (loseResponse) {
      throw new OcboxError({
        code: 'PROVIDER_TIMEOUT',
        message: `Fake provider intentionally lost the ${action} response`,
        requestId: context.requestId,
        providerCode: 'FAKE_LOST_RESPONSE',
      })
    }
    if (result === undefined) throw new TypeError('Fake mutation did not produce a result')
    return SandboxMutationResultSchema.parse(result)
  }

  #transition(
    entry: FakeProviderResource,
    context: OperationContext,
    target: Extract<ProviderLifecycleState, 'running' | 'paused' | 'stopped' | 'deleted'>,
    rawState: string,
  ): Sandbox {
    const now = this.#now().toISOString()
    const prior = timestamps(entry.sandbox.lifecycle.lifecycleTimestamps)
    const field =
      target === 'running'
        ? 'runningAt'
        : target === 'paused'
          ? 'pausedAt'
          : target === 'stopped'
            ? 'stoppedAt'
            : 'deletedAt'
    const sandbox = SandboxSchema.parse({
      ...entry.sandbox,
      lifecycle: {
        normalizedState: target,
        rawState,
        desiredState: target,
        reason: null,
        observedAt: now,
        lifecycleTimestamps: { ...prior, [field]: now, lastTransitionAt: now },
      },
      updatedAt: now,
    })
    entry.sandbox = sandbox
    entry.lastOperationId = context.operationId
    return sandbox
  }

  #observe(sandbox: Sandbox): Sandbox {
    const now = this.#now().toISOString()
    return SandboxSchema.parse({
      ...sandbox,
      lifecycle: { ...sandbox.lifecycle, observedAt: now },
      updatedAt: now,
    })
  }

  #result(
    context: OperationContext,
    sessionId: FakeProviderResource['sessionId'],
    action: Extract<OperationAction, 'create' | 'start' | 'pause' | 'resume' | 'stop' | 'destroy'>,
    sandbox: Sandbox,
    resolution: Operation['idempotencyResolution'],
  ): SandboxMutationResult {
    const completedAt = sandbox.lifecycle.observedAt
    return {
      operation: OperationSchema.parse({
        id: context.operationId,
        requestId: context.requestId,
        sessionId,
        sandboxId: sandbox.id,
        action,
        status: 'succeeded',
        idempotencyKey: context.idempotencyKey,
        idempotencyResolution: resolution,
        providerVerifiedAt: completedAt,
        createdAt: context.issuedAt,
        startedAt: context.issuedAt,
        completedAt,
      }),
      sandbox,
    } as SandboxMutationResult
  }

  async #before(action: OperationAction, context: OperationContext): Promise<void> {
    const milliseconds = this.#faults.delayMilliseconds?.[action] ?? 0
    if (milliseconds > 0) {
      try {
        await delay(milliseconds, undefined, { signal: this.#signal })
      } catch (error) {
        if (this.#signal?.aborted === true) {
          throw new OcboxError({
            code: 'OPERATION_CANCELLED',
            message: `Fake provider ${action} operation was cancelled`,
            requestId: context.requestId,
            providerCode: 'FAKE_CANCELLED',
          })
        }
        throw error
      }
    }
    const failure = this.#faults.failures?.[action]
    if (failure !== undefined) {
      throw new OcboxError({
        code: failure,
        message: `Fake provider injected ${action} failure`,
        requestId: context.requestId,
        providerCode: 'FAKE_INJECTED_FAILURE',
      })
    }
  }

  #unsupported<Result>(
    requestId: RequestContext['requestId'],
    capability: string,
  ): Promise<Result> {
    return Promise.reject(
      new OcboxError({
        code: 'CAPABILITY_UNSUPPORTED',
        message: `Fake provider does not support ${capability}`,
        requestId,
        details: { capability },
      }),
    )
  }
}

export { FAKE_CAPABILITIES }

import { randomUUID } from 'node:crypto'
import type { OcboxApiClient } from '../../api/client/client.js'
import { envelopeOf, toRequestId } from '../../api/client/errors.js'
import type {
  Operation as HostedOperation,
  Session as HostedSession,
} from '../../api/generated/client.js'
import {
  OperationSchema,
  type Operation,
  type OperationAction,
  type OperationContext,
  type RequestContext,
} from '../../domain/operation.js'
import { SandboxSchema, type Sandbox } from '../../domain/entities.js'
import { ProviderLifecycleObservationSchema } from '../../domain/lifecycle.js'
import { SandboxIdSchema, type RequestId } from '../../domain/ids.js'
import { ProviderSandboxIdSchema } from '../../domain/ids.js'
import { UtcTimestampSchema } from '../../domain/timestamps.js'
import type { SandboxSpec } from '../../domain/spec.js'
import { OcboxError } from '../../errors/index.js'
import type { ApplySourceRequest, ApplySourceResult } from '../contract/source.js'
import type {
  CancelExecutionRequest,
  CreateSandboxRequest,
  GetSandboxRequest,
  LifecycleMutationRequest,
  ListSandboxesRequest,
  SandboxMutationResult,
  SandboxProvider,
} from '../contract/provider.js'
import type { ProviderCapabilities } from '../contract/capabilities.js'
import type { ProviderFiles } from '../contract/files.js'
import type {
  ProviderPreviews,
  CreatePreviewRequest,
  RevokePreviewRequest,
  Preview,
} from '../contract/preview.js'
import type { ProviderSource } from '../contract/source.js'
import type { ProviderExecution } from '../contract/provider.js'
import type { ExecRequest, ExecHandle, ExecResult, Execution } from '../../domain/execution.js'
import { ExecutionIdSchema } from '../../domain/ids.js'
import { assertOwnedSession, resolvePrimaryBinding } from './mapping.js'
import { waitForHostedOperation } from './operations.js'
import { collectExecutionEvents, toExecEvents, toExecResult } from './executions.js'

const HOSTED_CAPABILITIES: ProviderCapabilities = {
  runtimeClasses: ['container'],
  lifecycle: {
    preservesFilesystemOnStop: true,
    supportsMemoryPause: false,
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
  previews: { supported: true, authenticated: true, http: true, websocket: false },
  egressModes: ['open', 'restricted', 'blocked'],
  metadataSearch: true,
  secretExposureModes: ['unsupported'],
  limits: {
    maxCpuMillicores: null,
    maxMemoryBytes: null,
    maxDiskBytes: null,
    maxExecutionMilliseconds: 3_600_000,
    maxFileBytes: null,
    maxConcurrentExecutions: null,
    maxSandboxes: null,
    maxSandboxesPerSession: 1,
  },
}

interface SandboxRecord {
  localId: string
  localSessionId: string
  localProjectId: string
  hostedSessionId: string
  hostedSandboxId: string
  spec: SandboxSpec
  createdAt: string
  updatedAt: string
}

export interface OcboxProviderOptions {
  readonly api: OcboxApiClient
  readonly hostedProjectId: string
  readonly now?: (() => string) | undefined
  readonly createId?: (() => string) | undefined
}

function notFoundSandbox(requestId: RequestId): OcboxError {
  return new OcboxError({
    code: 'SANDBOX_NOT_FOUND',
    message: 'The requested sandbox was not found',
    requestId,
  })
}

function unsupported(requestId: RequestId, capability: string): OcboxError {
  return new OcboxError({
    code: 'CAPABILITY_UNSUPPORTED',
    message: `The hosted provider does not support ${capability}`,
    requestId,
    details: { capability },
  })
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

function commandString(request: ExecRequest): string {
  if (request.command.mode === 'shell') return request.command.shell
  return request.command.argv.map(shellQuote).join(' ')
}

/** Hosted `ocbox` provider over the pinned `/v1` contract. */
export class OcboxSandboxProvider implements SandboxProvider {
  readonly name = 'ocbox'
  readonly #api: OcboxApiClient
  readonly #hostedProjectId: string
  readonly #now: () => string
  readonly #createId: () => string
  readonly #sandboxes = new Map<string, SandboxRecord>()
  readonly #executions = new Map<
    string,
    { hostedId: string; localSessionId: string; localSandboxId: string }
  >()
  readonly #previews = new Map<string, string>()

  constructor(options: OcboxProviderOptions) {
    if (options.hostedProjectId.trim().length === 0) {
      throw new TypeError('The hosted project ID must be a non-empty string')
    }
    this.#api = options.api
    this.#hostedProjectId = options.hostedProjectId
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#createId = options.createId ?? randomUUID
  }

  /** Test seam: seed a sandbox mapping without a network round-trip. */
  seedForTests(record: {
    localId: string
    localSessionId: string
    localProjectId: string
    hostedSessionId: string
    hostedSandboxId: string
    spec: SandboxSpec
  }): void {
    const now = this.#now()
    this.#sandboxes.set(record.localId, {
      createdAt: now,
      hostedSandboxId: record.hostedSandboxId,
      hostedSessionId: record.hostedSessionId,
      localId: record.localId,
      localProjectId: record.localProjectId,
      localSessionId: record.localSessionId,
      spec: record.spec,
      updatedAt: now,
    })
  }

  readonly exec: ProviderExecution = {
    execute: (context: OperationContext, request: ExecRequest): Promise<ExecHandle> =>
      this.#execute(context, request),
    cancel: (context: OperationContext, request: CancelExecutionRequest): Promise<Operation> =>
      this.#cancelExecution(context, request),
  }

  readonly files: ProviderFiles = {
    read: (context) => Promise.reject(unsupported(context.requestId, 'files_read')),
    write: (context) => Promise.reject(unsupported(context.requestId, 'files_write')),
    list: (context) => Promise.reject(unsupported(context.requestId, 'files_list')),
    stat: (context) => Promise.reject(unsupported(context.requestId, 'files_stat')),
    checksum: (context) => Promise.reject(unsupported(context.requestId, 'files_checksum')),
    makeDirectory: (context) =>
      Promise.reject(unsupported(context.requestId, 'files_make_directory')),
    remove: (context) => Promise.reject(unsupported(context.requestId, 'files_remove')),
    move: (context) => Promise.reject(unsupported(context.requestId, 'files_move')),
  }

  readonly source: ProviderSource = {
    apply: (context: OperationContext, request: ApplySourceRequest): Promise<ApplySourceResult> =>
      this.#applySource(context, request),
  }

  readonly previews: ProviderPreviews = {
    create: (context: OperationContext, request: CreatePreviewRequest): Promise<Preview> =>
      this.#createPreview(context, request),
    revoke: (context: OperationContext, request: RevokePreviewRequest): Promise<Operation> =>
      this.#revokePreview(context, request),
  }

  capabilities(_context: RequestContext): Promise<ProviderCapabilities> {
    return Promise.resolve(HOSTED_CAPABILITIES)
  }

  async create(
    context: OperationContext,
    request: CreateSandboxRequest,
  ): Promise<SandboxMutationResult> {
    await this.#assertProject(context.requestId)
    const created = await this.#api.generated.createSession({
      path: { projectId: this.#hostedProjectId },
      body: {},
      idempotencyKey: context.idempotencyKey,
    })
    const started = this.#api.assertSuccess('createSession', created, [200, 202])
    const hostedOp = started.body as HostedOperation
    const waited = await waitForHostedOperation(this.#api, hostedOp.id)
    const hostedSessionId = waited.operation.sessionId ?? (hostedOp.sessionId as string | null)
    if (hostedSessionId === null || hostedSessionId === undefined) {
      throw new OcboxError({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'The hosted service did not return a session for the created operation',
        requestId: toRequestId(waited.requestId),
      })
    }
    const session = await this.#getOwnedSession(hostedSessionId)
    const primary = resolvePrimaryBinding(session)
    if (primary === null) {
      throw new OcboxError({
        code: 'INVALID_STATE',
        message: 'The hosted session has no active primary sandbox binding',
        providerCode: 'MISSING_PRIMARY_BINDING',
        requestId: toRequestId(waited.requestId),
      })
    }
    const now = this.#now()
    const localId = SandboxIdSchema.parse(this.#createId())
    const record: SandboxRecord = {
      createdAt: now,
      hostedSandboxId: primary.sandboxId,
      hostedSessionId: session.id,
      localId,
      localProjectId: request.projectId,
      localSessionId: request.sessionId,
      spec: request.specification,
      updatedAt: now,
    }
    this.#sandboxes.set(localId, record)
    const sandbox = this.#sandboxOf(record, primary.state, now, request.specification)
    const operation = this.#operationOf(context, {
      action: 'create',
      replay: started.meta.replay,
      sandboxId: localId,
      sessionId: request.sessionId,
      verifiedAt: now,
    })
    return { operation, sandbox }
  }

  async get(context: RequestContext, request: GetSandboxRequest): Promise<Sandbox | null> {
    const record = this.#sandboxes.get(request.sandboxId)
    if (record === undefined) return null
    const session = await this.#getOwnedSession(record.hostedSessionId)
    const primary = resolvePrimaryBinding(session)
    if (primary === null || primary.sandboxId !== record.hostedSandboxId) {
      throw new OcboxError({
        code: 'INVALID_STATE',
        message: 'The hosted primary binding changed for this sandbox',
        providerCode: 'PRIMARY_BINDING_CHANGED',
        requestId: context.requestId,
      })
    }
    const now = this.#now()
    record.updatedAt = now
    return this.#sandboxOf(record, primary.state, now, record.spec)
  }

  async list(context: RequestContext, request: ListSandboxesRequest): Promise<readonly Sandbox[]> {
    const page = await this.#api.generated.listSessions({
      path: { projectId: this.#hostedProjectId },
    })
    const listed = this.#api.assertSuccess('listSessions', page, [200])
    const sessions = (listed.body as { data: readonly HostedSession[] }).data
    const out: Sandbox[] = []
    for (const session of sessions) {
      if (session.projectId !== this.#hostedProjectId) continue
      const primary = resolvePrimaryBinding(session)
      if (primary === null) continue
      const existing = [...this.#sandboxes.values()].find(
        (record) => record.hostedSandboxId === primary.sandboxId,
      )
      if (request.sessionId !== null && request.sessionId !== undefined) {
        if (existing === undefined || existing.localSessionId !== request.sessionId) continue
      }
      if (request.projectId !== null && request.projectId !== undefined) {
        if (existing === undefined || existing.localProjectId !== request.projectId) continue
      }
      const now = this.#now()
      if (existing !== undefined) {
        existing.updatedAt = now
        out.push(this.#sandboxOf(existing, primary.state, now, existing.spec))
      } else {
        void context
      }
    }
    return out
  }

  async start(
    context: OperationContext,
    request: LifecycleMutationRequest,
  ): Promise<SandboxMutationResult> {
    return this.#mutate(context, request, 'start', 'running')
  }

  async pause(
    context: OperationContext,
    request: LifecycleMutationRequest,
  ): Promise<SandboxMutationResult> {
    return this.#mutate(context, request, 'pause', 'paused')
  }

  async resume(
    context: OperationContext,
    request: LifecycleMutationRequest,
  ): Promise<SandboxMutationResult> {
    return this.#mutate(context, request, 'resume', 'running')
  }

  async stop(
    context: OperationContext,
    request: LifecycleMutationRequest,
  ): Promise<SandboxMutationResult> {
    return this.#mutate(context, request, 'stop', 'stopped')
  }

  async destroy(
    context: OperationContext,
    request: LifecycleMutationRequest,
  ): Promise<SandboxMutationResult> {
    return this.#mutate(context, request, 'destroy', 'deleted')
  }

  async #assertProject(requestId: string): Promise<void> {
    const result = await this.#api.generated.getProject({
      path: { projectId: this.#hostedProjectId },
    })
    if (result.status === 404) {
      throw new OcboxError({
        code: 'PROJECT_NOT_FOUND',
        message: 'The configured hosted project was not found',
        requestId: toRequestId(result.requestId ?? requestId),
      })
    }
    this.#api.assertSuccess('getProject', result, [200])
  }

  async #getOwnedSession(hostedSessionId: string): Promise<HostedSession> {
    const result = await this.#api.generated.getSession({ path: { sessionId: hostedSessionId } })
    if (result.status === 404) {
      const envelope = envelopeOf(result.body)
      throw new OcboxError({
        code: 'SANDBOX_NOT_FOUND',
        message: 'The hosted session was not found',
        requestId: toRequestId(result.requestId ?? envelope.requestId),
      })
    }
    const { body } = this.#api.assertSuccess('getSession', result, [200])
    const session = body as HostedSession
    assertOwnedSession(session, this.#hostedProjectId)
    return session
  }

  async #mutate(
    context: OperationContext,
    request: LifecycleMutationRequest,
    action: Extract<OperationAction, 'start' | 'pause' | 'resume' | 'stop' | 'destroy'>,
    expected: 'running' | 'paused' | 'stopped' | 'deleted',
  ): Promise<SandboxMutationResult> {
    const record = this.#sandboxes.get(request.sandboxId)
    if (record === undefined) throw notFoundSandbox(context.requestId)
    await this.#assertProject(context.requestId)
    const invoke = {
      destroy: () =>
        this.#api.generated.destroySession({
          path: { sessionId: record.hostedSessionId },
          idempotencyKey: context.idempotencyKey,
        }),
      pause: () =>
        this.#api.generated.pauseSession({
          path: { sessionId: record.hostedSessionId },
          idempotencyKey: context.idempotencyKey,
        }),
      start: () =>
        this.#api.generated.startSession({
          path: { sessionId: record.hostedSessionId },
          idempotencyKey: context.idempotencyKey,
        }),
      resume: () =>
        this.#api.generated.startSession({
          path: { sessionId: record.hostedSessionId },
          idempotencyKey: context.idempotencyKey,
        }),
      stop: () =>
        this.#api.generated.stopSession({
          path: { sessionId: record.hostedSessionId },
          idempotencyKey: context.idempotencyKey,
        }),
    }[action]
    const initiated = await invoke()
    const started = this.#api.assertSuccess(`${action}Session`, initiated, [200, 202])
    const hostedOp = started.body as HostedOperation
    const waited = await waitForHostedOperation(this.#api, hostedOp.id)
    const session = await this.#getOwnedSession(record.hostedSessionId)
    const now = this.#now()
    record.updatedAt = now
    if (expected === 'deleted') {
      const sandbox = this.#sandboxOf(record, 'stopped', now, record.spec, 'deleted')
      const operation = this.#operationOf(context, {
        action,
        replay: started.meta.replay,
        sandboxId: record.localId,
        sessionId: record.localSessionId,
        verifiedAt: now,
      })
      return { operation, sandbox }
    }
    const primary = resolvePrimaryBinding(session)
    if (primary === null || primary.sandboxId !== record.hostedSandboxId) {
      throw new OcboxError({
        code: 'INVALID_STATE',
        message: 'The hosted primary binding changed during the operation',
        providerCode: 'PRIMARY_BINDING_CHANGED',
        requestId: toRequestId(waited.requestId),
      })
    }
    const sandbox = this.#sandboxOf(record, primary.state, now, record.spec, expected)
    const operation = this.#operationOf(context, {
      action,
      replay: started.meta.replay,
      sandboxId: record.localId,
      sessionId: record.localSessionId,
      verifiedAt: now,
    })
    return { operation, sandbox }
  }

  #operationOf(
    context: OperationContext,
    input: {
      sessionId: string
      sandboxId: string | null
      action: OperationAction
      verifiedAt: string
      replay: boolean
    },
  ): Operation {
    const lifecycle = new Set<OperationAction>([
      'create',
      'start',
      'pause',
      'stop',
      'resume',
      'destroy',
    ])
    const previewLifecycle = actionIsPreview(input.action)
    const terminal = lifecycle.has(input.action) || previewLifecycle
    return OperationSchema.parse({
      action: input.action,
      completedAt: terminal ? input.verifiedAt : null,
      createdAt: context.issuedAt,
      id: context.operationId,
      idempotencyKey: context.idempotencyKey,
      idempotencyResolution: input.replay
        ? { kind: 'replayed_result', originalOperationId: context.operationId }
        : { kind: 'created' },
      providerVerifiedAt: lifecycle.has(input.action) ? input.verifiedAt : null,
      requestId: context.requestId,
      sandboxId: input.sandboxId,
      sessionId: input.sessionId,
      startedAt: terminal ? context.issuedAt : null,
      status: 'succeeded',
    })
  }

  #sandboxOf(
    record: SandboxRecord,
    bindingState: 'running' | 'stopped',
    observedAt: string,
    spec: SandboxSpec,
    forceNormalized?: 'running' | 'paused' | 'stopped' | 'deleted',
  ): Sandbox {
    const normalized = forceNormalized ?? (bindingState === 'running' ? 'running' : 'stopped')
    const observation = ProviderLifecycleObservationSchema.parse({
      desiredState: null,
      lifecycleTimestamps: {
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
      },
      normalizedState: normalized,
      observedAt: UtcTimestampSchema.parse(observedAt),
      rawState: bindingState,
      reason: null,
    })
    return SandboxSchema.parse({
      createdAt: record.createdAt,
      id: record.localId,
      lifecycle: observation,
      projectId: record.localProjectId,
      provider: 'ocbox',
      providerSandboxId: ProviderSandboxIdSchema.parse(record.hostedSandboxId),
      specification: { effective: null, effectiveObservedAt: null, requested: spec },
      updatedAt: observedAt,
    })
  }

  async #execute(context: OperationContext, request: ExecRequest): Promise<ExecHandle> {
    const record = this.#sandboxes.get(request.sandboxId)
    if (record === undefined) throw notFoundSandbox(context.requestId)
    const owned = await this.#getOwnedSession(record.hostedSessionId)
    const primary = resolvePrimaryBinding(owned)
    if (primary === null || primary.sandboxId !== record.hostedSandboxId) {
      throw new OcboxError({
        code: 'INVALID_STATE',
        message: 'The hosted Session primary Sandbox binding does not match the requested Sandbox',
        requestId: context.requestId,
      })
    }
    const timeoutSeconds =
      request.timeoutMilliseconds === null
        ? undefined
        : Math.min(3600, Math.max(1, Math.ceil(request.timeoutMilliseconds / 1000)))
    const started = await this.#api.generated.createExecution({
      path: { sessionId: record.hostedSessionId },
      body: {
        command: commandString(request),
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      },
      idempotencyKey: context.idempotencyKey,
    })
    const created = this.#api.assertSuccess('createExecution', started, [200, 202])
    const hosted = created.body as {
      id: string
      createdAt: string
      sessionId?: unknown
      sandboxId?: unknown
    }
    if (
      (typeof hosted.sessionId === 'string' && hosted.sessionId !== record.hostedSessionId) ||
      (typeof hosted.sandboxId === 'string' &&
        hosted.sandboxId !== record.hostedSandboxId &&
        hosted.sandboxId !== null)
    ) {
      throw new OcboxError({
        code: 'INVALID_STATE',
        message: 'The hosted Execution does not belong to the requested Session and Sandbox',
        requestId: context.requestId,
      })
    }
    const localExecutionId = ExecutionIdSchema.parse(this.#createId())
    this.#executions.set(localExecutionId, {
      hostedId: hosted.id,
      localSandboxId: request.sandboxId,
      localSessionId: record.localSessionId,
    })
    const collected = await collectExecutionEvents(this.#api, hosted.id)
    const latest = collected.events[collected.events.length - 1]
    const completedAt = latest?.at ?? this.#now()
    const createdRecord = await this.#api.generated.getExecution({
      path: { executionId: hosted.id },
    })
    const current = this.#api.assertSuccess('getExecution', createdRecord, [200])
    const hostedExecution = current.body as { createdAt: string }
    const result: ExecResult = toExecResult(collected.result, {
      completedAt: UtcTimestampSchema.parse(completedAt),
      startedAt: UtcTimestampSchema.parse(hostedExecution.createdAt),
    })
    const execution: Execution = {
      command: request.command,
      completedAt: result.completedAt,
      createdAt: UtcTimestampSchema.parse(hosted.createdAt ?? hostedExecution.createdAt),
      id: localExecutionId,
      operationId: context.operationId,
      result,
      sandboxId: request.sandboxId,
      startedAt: result.startedAt,
      status: 'completed',
    }
    const events = toExecEvents(localExecutionId, collected.events, { startedAt: result.startedAt })
    async function* stream(): AsyncGenerator<(typeof events)[number]> {
      for (const event of events) yield event
      yield {
        executionId: localExecutionId,
        result,
        sequence: events.length,
        timestamp: result.completedAt,
        type: 'completed',
      }
    }
    return { events: stream(), execution, result: Promise.resolve(result) }
  }

  async #cancelExecution(
    context: OperationContext,
    request: CancelExecutionRequest,
  ): Promise<Operation> {
    const tracked = this.#executions.get(request.executionId)
    if (tracked === undefined) {
      throw new OcboxError({
        code: 'SANDBOX_NOT_FOUND',
        message: 'The hosted execution was not found',
        requestId: context.requestId,
      })
    }
    const result = await this.#api.generated.cancelExecution({
      path: { executionId: tracked.hostedId },
      idempotencyKey: context.idempotencyKey,
    })
    this.#api.assertSuccess('cancelExecution', result, [200, 202])
    return OperationSchema.parse({
      action: 'exec_cancel',
      completedAt: null,
      createdAt: context.issuedAt,
      id: context.operationId,
      idempotencyKey: context.idempotencyKey,
      idempotencyResolution: null,
      providerVerifiedAt: null,
      requestId: context.requestId,
      sandboxId: tracked.localSandboxId,
      sessionId: tracked.localSessionId,
      startedAt: context.issuedAt,
      status: 'running',
    })
  }

  async #applySource(
    context: OperationContext,
    request: ApplySourceRequest,
  ): Promise<ApplySourceResult> {
    if (request.source.kind === 'none') {
      const record = this.#sandboxes.get(request.sandboxId)
      if (record === undefined) throw notFoundSandbox(context.requestId)
      const now = this.#now()
      const operation = OperationSchema.parse({
        action: 'source_apply',
        completedAt: now,
        createdAt: context.issuedAt,
        id: context.operationId,
        idempotencyKey: context.idempotencyKey,
        idempotencyResolution: { kind: 'created' },
        providerVerifiedAt: null,
        requestId: context.requestId,
        sandboxId: request.sandboxId,
        sessionId: record.localSessionId,
        startedAt: context.issuedAt,
        status: 'succeeded',
      })
      return {
        contentDigestSha256: '0'.repeat(64),
        operation,
        sandboxId: request.sandboxId,
      }
    }
    throw unsupported(context.requestId, 'source_apply')
  }

  async #createPreview(context: OperationContext, request: CreatePreviewRequest): Promise<Preview> {
    const record = this.#sandboxes.get(request.sandboxId)
    if (record === undefined) throw notFoundSandbox(context.requestId)
    const ttlSeconds = Math.max(
      60,
      Math.min(86400, Math.ceil(request.expiresInMilliseconds / 1000)),
    )
    const protocol =
      request.protocol === 'wss'
        ? 'wss'
        : request.protocol === 'ws'
          ? 'ws'
          : request.protocol === 'https'
            ? 'https'
            : 'http'
    const created = await this.#api.generated.createPreview({
      path: { sessionId: record.hostedSessionId },
      body: { port: request.port, ttlSeconds },
      idempotencyKey: context.idempotencyKey,
    })
    const done = this.#api.assertSuccess('createPreview', created, [200, 202])
    const hosted = done.body as { id: string; url: string; expiresAt: string }
    const url = new URL(hosted.url)
    if (url.username !== '' || url.password !== '' || url.protocol.slice(0, -1) !== protocol) {
      throw new OcboxError({
        code: 'PREVIEW_UNAVAILABLE',
        message: 'The hosted preview URL did not match the requested protocol',
        requestId: toRequestId(done.meta.requestId),
      })
    }
    this.#previews.set(hosted.url, hosted.id)
    const now = this.#now()
    const operation = OperationSchema.parse({
      action: 'preview_create',
      completedAt: now,
      createdAt: context.issuedAt,
      id: context.operationId,
      idempotencyKey: context.idempotencyKey,
      idempotencyResolution: done.meta.replay
        ? { kind: 'replayed_result', originalOperationId: context.operationId }
        : { kind: 'created' },
      providerVerifiedAt: null,
      requestId: context.requestId,
      sandboxId: request.sandboxId,
      sessionId: record.localSessionId,
      startedAt: context.issuedAt,
      status: 'succeeded',
    })
    return {
      authenticated: true,
      expiresAt: UtcTimestampSchema.parse(hosted.expiresAt),
      operation,
      port: request.port,
      protocol,
      sandboxId: request.sandboxId,
      url: hosted.url,
    }
  }

  async #revokePreview(
    context: OperationContext,
    request: RevokePreviewRequest,
  ): Promise<Operation> {
    const previewId = this.#previews.get(request.url)
    if (previewId === undefined) {
      throw new OcboxError({
        code: 'PREVIEW_UNAVAILABLE',
        message: 'The hosted preview was not found',
        requestId: context.requestId,
      })
    }
    const record = this.#sandboxes.get(request.sandboxId)
    if (record === undefined) throw notFoundSandbox(context.requestId)
    const result = await this.#api.generated.deletePreview({
      path: { previewId },
      idempotencyKey: context.idempotencyKey,
    })
    this.#api.assertSuccess('deletePreview', result, [200, 202])
    this.#previews.delete(request.url)
    return OperationSchema.parse({
      action: 'preview_revoke',
      completedAt: null,
      createdAt: context.issuedAt,
      id: context.operationId,
      idempotencyKey: context.idempotencyKey,
      idempotencyResolution: null,
      providerVerifiedAt: null,
      requestId: context.requestId,
      sandboxId: request.sandboxId,
      sessionId: record.localSessionId,
      startedAt: context.issuedAt,
      status: 'running',
    })
  }
}

function actionIsPreview(action: OperationAction): boolean {
  return action === 'preview_create' || action === 'preview_revoke'
}

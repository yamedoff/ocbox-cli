import { createHash, randomUUID } from 'node:crypto'
import {
  assertCapabilitySupported,
  assertSessionTransition,
  BindingIdSchema,
  IdempotencyKeySchema,
  OperationIdSchema,
  OperationSchema,
  ProjectIdSchema,
  RequestIdSchema,
  SessionIdSchema,
  SessionSchema,
  UtcTimestampSchema,
  type Operation,
  type OperationAction,
  type OperationContext,
  type ProjectId,
  type Sandbox,
  type SandboxProvider,
  type Session,
} from '../contracts.js'
import { toSandboxSpec, type ProjectConfig } from '../config/index.js'
import { OcboxError } from '../errors/index.js'
import type { ExecutionTarget } from '../execution/service.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { AtomicStoreCancelledError, AtomicStoreConflictError } from './atomic-json-store.js'
import type { LifecycleProjectState } from './schema.js'
import type { LifecycleStore } from './store.js'

type LifecycleAction = Extract<
  OperationAction,
  'create' | 'start' | 'resume' | 'pause' | 'stop' | 'destroy'
>

export interface SessionView {
  readonly selected: boolean
  readonly session: Session
  readonly sandbox: Sandbox | null
  readonly operation: Operation | null
  readonly capabilities: Awaited<ReturnType<SandboxProvider['capabilities']>>
}

export interface LifecycleServiceOptions {
  readonly config: ProjectConfig
  readonly projectId: ProjectId
  readonly store: LifecycleStore
  readonly registry: ProviderRegistry
  readonly now?: () => Date
  readonly createId?: () => string
  readonly signal?: AbortSignal
}

function copyState(state: LifecycleProjectState): LifecycleProjectState {
  return structuredClone(state)
}

/** Orchestrates persisted Session operations over the provider-neutral port. */
export class LifecycleService {
  readonly #config: ProjectConfig
  readonly #projectId: ProjectId
  readonly #store: LifecycleStore
  readonly #registry: ProviderRegistry
  readonly #now: () => Date
  readonly #createId: () => string
  readonly #signal: AbortSignal | undefined

  #timestamp() {
    return UtcTimestampSchema.parse(this.#now().toISOString())
  }

  constructor(options: LifecycleServiceOptions) {
    this.#config = options.config
    this.#projectId = options.projectId
    this.#store = options.store
    this.#registry = options.registry
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? randomUUID
    this.#signal = options.signal
  }

  async start(createNew = false): Promise<SessionView> {
    const state = await this.#store.load()
    const selected =
      state.activeSessionId === null ? undefined : state.sessions[state.activeSessionId]
    if (createNew || selected === undefined) return this.#createSession(createNew)
    if (selected.state === 'creating') return this.#continueCreate(selected)
    if (selected.state === 'active') return this.#refreshActive(selected)
    if (selected.state === 'paused') return this.#runMutation(selected.id, 'resume')
    if (selected.state === 'stopped') return this.#runMutation(selected.id, 'start')
    if (['pausing', 'stopping', 'resuming'].includes(selected.state)) {
      const operation =
        selected.currentOperationId === null
          ? undefined
          : state.operations[selected.currentOperationId]
      if (
        operation?.action === 'pause' ||
        operation?.action === 'stop' ||
        operation?.action === 'resume' ||
        operation?.action === 'start'
      ) {
        return this.#runMutation(selected.id, operation.action)
      }
    }
    throw this.#invalidState(
      selected,
      `Session ${selected.id} cannot be started from ${selected.state}; select or create another Session explicitly`,
    )
  }

  pause(sessionId?: string): Promise<SessionView> {
    return this.#withResolvedSession(sessionId, (session) => this.#runMutation(session.id, 'pause'))
  }

  stop(sessionId?: string): Promise<SessionView> {
    return this.#withResolvedSession(sessionId, (session) => this.#runMutation(session.id, 'stop'))
  }

  destroy(sessionId?: string): Promise<SessionView> {
    return this.#withResolvedSession(sessionId, (session) =>
      session.state === 'destroyed'
        ? this.#view(session.id)
        : this.#runMutation(session.id, 'destroy'),
    )
  }

  async use(sessionId: string): Promise<SessionView> {
    const parsedId = SessionIdSchema.parse(sessionId)
    await this.#update((current) => {
      if (current.sessions[parsedId] === undefined) throw this.#notFound(parsedId)
      return { ...current, activeSessionId: parsedId }
    })
    return this.#view(parsedId)
  }

  async status(sessionId?: string): Promise<SessionView> {
    const session = await this.#resolveSession(sessionId)
    return this.#view(session.id)
  }

  /**
   * Resolves the provider-neutral execution target for `ocbox exec`. This is the
   * single composition point between the lifecycle state and the execution port:
   * it selects `--session` or the active Session, enforces the v0.1 single primary
   * running Sandbox binding, and never creates or replaces a Session or Sandbox.
   */
  async executionTarget(sessionId?: string): Promise<ExecutionTarget> {
    const selected = await this.#resolveSession(sessionId)
    const state = await this.#store.load()
    const session = state.sessions[selected.id]
    if (session === undefined) throw this.#notFound(selected.id)
    if (session.state !== 'active') {
      throw this.#invalidState(
        session,
        `Session ${session.id} is ${session.state}; ocbox exec requires an active Session`,
      )
    }

    const activeBindings = session.bindings.filter((binding) => binding.releasedAt === null)
    if (activeBindings.length > 1) {
      throw this.#invalidState(
        session,
        `Session ${session.id} has ambiguous active Sandbox bindings; v0.1 permits exactly one`,
      )
    }
    const binding = activeBindings[0]
    if (binding === undefined || binding.role !== 'primary') {
      throw this.#invalidState(
        session,
        `Session ${session.id} has no active primary Sandbox binding; run ocbox start`,
      )
    }
    const sandbox = state.sandboxes[binding.sandboxId]
    if (sandbox === undefined || sandbox.projectId !== session.projectId) {
      throw new OcboxError({
        code: 'SANDBOX_NOT_FOUND',
        message: `Session ${session.id} primary Sandbox binding is missing`,
        requestId: RequestIdSchema.parse(this.#createId()),
        details: { sessionId: session.id },
      })
    }
    if (sandbox.lifecycle.normalizedState !== 'running') {
      throw this.#invalidState(
        session,
        `Session ${session.id} Sandbox is ${sandbox.lifecycle.normalizedState}; run ocbox start`,
      )
    }

    const requestId = RequestIdSchema.parse(this.#createId())
    const provider = this.#provider(requestId)
    const capabilities = await provider.capabilities({
      requestId,
      issuedAt: this.#timestamp(),
    })
    if (!capabilities.execution.streaming || !capabilities.execution.cancellation) {
      throw new OcboxError({
        code: 'CAPABILITY_UNSUPPORTED',
        message: `Provider ${provider.name} does not support streaming cancellable execution`,
        requestId,
        details: { provider: provider.name },
      })
    }
    return { session, sandbox, capabilities, provider }
  }

  async list(): Promise<readonly SessionView[]> {
    const state = await this.#store.load()
    return Promise.all(
      Object.values(state.sessions)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((session) => this.#viewFromState(state, session.id)),
    )
  }

  async #createSession(forceNew: boolean): Promise<SessionView> {
    const requestId = RequestIdSchema.parse(this.#createId())
    const operationId = OperationIdSchema.parse(this.#createId())
    const sessionId = SessionIdSchema.parse(this.#createId())
    const now = this.#timestamp()
    const operation = OperationSchema.parse({
      id: operationId,
      requestId,
      sessionId,
      sandboxId: null,
      action: 'create',
      status: 'running',
      idempotencyKey: IdempotencyKeySchema.parse(`create:${sessionId}:${operationId}`),
      idempotencyResolution: null,
      providerVerifiedAt: null,
      createdAt: now,
      startedAt: now,
      completedAt: null,
    })
    const session = SessionSchema.parse({
      id: sessionId,
      projectId: this.#projectId,
      state: 'creating',
      bindings: [],
      currentOperationId: operationId,
      providerVerifiedAt: null,
      sandboxDeletionVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    const spec = toSandboxSpec(this.#config)
    let reserved = false
    await this.#update((current) => {
      if (!forceNew && current.activeSessionId !== null) return current
      const next = copyState(current)
      next.sessions[sessionId] = session
      next.operations[operationId] = operation
      next.operationAttempts[operationId] = 1
      next.pendingCreateSpecs[operationId] = spec
      next.activeSessionId = sessionId
      reserved = true
      return next
    })
    if (!reserved) return this.start(false)
    return this.#continueCreate(session)
  }

  async #continueCreate(session: Session): Promise<SessionView> {
    if (session.currentOperationId === null)
      throw this.#invalidState(session, 'Create Operation is missing')
    let operation: Operation | undefined
    let attempt = 0
    let specification: ReturnType<typeof toSandboxSpec> | undefined
    await this.#update((current) => {
      const next = copyState(current)
      const latest = next.sessions[session.id]
      if (latest?.state !== 'creating' || latest.currentOperationId === null) return next
      operation = next.operations[latest.currentOperationId]
      specification = next.pendingCreateSpecs[latest.currentOperationId]
      if (operation === undefined || specification === undefined) {
        throw this.#invalidState(latest, 'Create recovery data is incomplete')
      }
      attempt = (next.operationAttempts[operation.id] ?? 0) + 1
      // The first attempt was reserved when the Operation was persisted.
      if (next.operationAttempts[operation.id] === 1) attempt = 1
      next.operationAttempts[operation.id] = attempt
      return next
    })
    if (operation === undefined || specification === undefined) return this.#view(session.id)
    const provider = this.#provider(operation.requestId)
    const context: OperationContext = {
      requestId: operation.requestId,
      issuedAt: operation.createdAt,
      operationId: operation.id,
      idempotencyKey: operation.idempotencyKey,
      attempt,
    }
    try {
      const result = await this.#abortable(
        provider.create(context, {
          projectId: this.#projectId,
          sessionId: session.id,
          specification,
          adoption: {
            strategy: 'metadata_search_then_adopt',
            metadata: { sessionId: session.id, operationId: operation.id },
          },
        }),
        operation.requestId,
      )
      return this.#complete(session.id, result.operation, result.sandbox, 'active')
    } catch (error) {
      await this.#recordFailure(session.id, operation, error)
      throw error
    }
  }

  async #refreshActive(session: Session): Promise<SessionView> {
    const state = await this.#store.load()
    const sandbox = this.#sandboxFor(state, session)
    const requestId = RequestIdSchema.parse(this.#createId())
    const provider = this.#provider(requestId)
    const observed = await provider.get(
      { requestId, issuedAt: this.#timestamp() },
      { sandboxId: sandbox.id },
    )
    if (observed === null) {
      throw new OcboxError({
        code: 'SANDBOX_NOT_FOUND',
        message: `Provider resource for Session ${session.id} is missing; run ocbox destroy --yes to reconcile deletion`,
        requestId,
        details: { sessionId: session.id },
      })
    }
    await this.#update((current) => {
      const next = copyState(current)
      const latest = next.sessions[session.id]
      if (latest?.state !== 'active' || latest.currentOperationId !== null) {
        throw this.#conflict(latest ?? session, 'start')
      }
      next.sandboxes[observed.id] = observed
      next.sessions[session.id] = SessionSchema.parse({
        ...latest,
        state: observed.lifecycle.normalizedState === 'running' ? 'active' : 'error',
        providerVerifiedAt: observed.lifecycle.observedAt,
        updatedAt: observed.lifecycle.observedAt,
      })
      return next
    })
    if (observed.lifecycle.normalizedState !== 'running') {
      throw this.#invalidState(session, 'Provider returned an ambiguous or non-running state')
    }
    return this.#view(session.id)
  }

  async #runMutation(
    sessionId: Session['id'],
    requestedAction: Exclude<LifecycleAction, 'create'>,
  ) {
    const initial = await this.#store.load()
    const initialSession = initial.sessions[sessionId]
    if (initialSession === undefined) throw this.#notFound(sessionId)
    const requestId = RequestIdSchema.parse(this.#createId())
    const provider = this.#provider(requestId)
    const capabilities = await provider.capabilities({
      requestId,
      issuedAt: this.#timestamp(),
    })
    if (requestedAction === 'pause')
      assertCapabilitySupported(capabilities, 'memory_pause', requestId)
    if (requestedAction === 'stop')
      assertCapabilitySupported(capabilities, 'filesystem_stop', requestId)

    let operation: Operation | undefined
    let sandbox: Sandbox | undefined
    let attempt = 1
    await this.#update((current) => {
      const next = copyState(current)
      const session = next.sessions[sessionId]
      if (session === undefined) throw this.#notFound(sessionId)
      sandbox = this.#sandboxFor(next, session)
      if (session.currentOperationId !== null) {
        const existing = next.operations[session.currentOperationId]
        if (existing?.action !== requestedAction) throw this.#conflict(session, requestedAction)
        operation = existing
        attempt = (next.operationAttempts[existing.id] ?? 1) + 1
        next.operationAttempts[existing.id] = attempt
        return next
      }

      const allowed = this.#allowedStates(requestedAction)
      if (!allowed.includes(session.state)) throw this.#invalidState(session)
      if (requestedAction === 'stop' && session.state === 'stopped') return next

      const operationId = OperationIdSchema.parse(this.#createId())
      const now = this.#timestamp()
      const transitional =
        requestedAction === 'pause'
          ? 'pausing'
          : requestedAction === 'stop'
            ? 'stopping'
            : requestedAction === 'destroy'
              ? 'destroying'
              : 'resuming'
      assertSessionTransition(session.state, transitional, { operationId })
      operation = OperationSchema.parse({
        id: operationId,
        requestId,
        sessionId,
        sandboxId: sandbox.id,
        action: requestedAction,
        status: 'running',
        idempotencyKey: IdempotencyKeySchema.parse(
          `${requestedAction}:${sessionId}:${operationId}`,
        ),
        idempotencyResolution: null,
        providerVerifiedAt: null,
        createdAt: now,
        startedAt: now,
        completedAt: null,
      })
      next.operations[operationId] = operation
      next.operationAttempts[operationId] = 1
      next.sessions[sessionId] = SessionSchema.parse({
        ...session,
        state: transitional,
        currentOperationId: operationId,
        updatedAt: now,
      })
      return next
    })
    if (operation === undefined || sandbox === undefined) return this.#view(sessionId)

    const context: OperationContext = {
      requestId: operation.requestId,
      issuedAt: operation.createdAt,
      operationId: operation.id,
      idempotencyKey: operation.idempotencyKey,
      attempt,
    }
    try {
      const result = await this.#abortable(
        this.#invoke(provider, requestedAction, context, sandbox.id),
        operation.requestId,
      )
      if (requestedAction === 'destroy') {
        const verification = await provider.get(
          { requestId: operation.requestId, issuedAt: this.#timestamp() },
          { sandboxId: sandbox.id },
        )
        if (verification !== null && verification.lifecycle.normalizedState !== 'deleted') {
          throw new OcboxError({
            code: 'INVALID_STATE',
            message: 'Provider deletion has not been verified',
            requestId: operation.requestId,
          })
        }
      }
      const target =
        requestedAction === 'pause'
          ? 'paused'
          : requestedAction === 'stop'
            ? 'stopped'
            : requestedAction === 'destroy'
              ? 'destroyed'
              : 'active'
      return this.#complete(sessionId, result.operation, result.sandbox, target)
    } catch (error) {
      await this.#recordFailure(sessionId, operation, error)
      throw error
    }
  }

  #invoke(
    provider: SandboxProvider,
    action: Exclude<LifecycleAction, 'create'>,
    context: OperationContext,
    sandboxId: Sandbox['id'],
  ) {
    switch (action) {
      case 'start':
        return provider.start(context, { sandboxId })
      case 'resume':
        return provider.resume(context, { sandboxId })
      case 'pause':
        return provider.pause(context, { sandboxId })
      case 'stop':
        return provider.stop(context, { sandboxId })
      case 'destroy':
        return provider.destroy(context, { sandboxId })
    }
  }

  async #complete(
    sessionId: Session['id'],
    operation: Operation,
    sandbox: Sandbox,
    target: Extract<Session['state'], 'active' | 'paused' | 'stopped' | 'destroyed'>,
  ): Promise<SessionView> {
    await this.#update((current) => {
      const next = copyState(current)
      const session = next.sessions[sessionId]
      if (session === undefined) throw this.#notFound(sessionId)
      if (session.currentOperationId !== operation.id) {
        // A concurrent follower already committed this exact Operation.
        if (next.operations[operation.id]?.status === 'succeeded') return next
        throw this.#conflict(session, operation.action)
      }
      assertSessionTransition(session.state, target, {
        operationId: operation.id,
        transitionStartedAt: operation.startedAt ?? operation.createdAt,
        providerObservation: sandbox.lifecycle,
      })
      const destroyed = target === 'destroyed'
      const bindings =
        session.bindings.length > 0
          ? session.bindings.map((binding) =>
              destroyed && binding.releasedAt === null
                ? { ...binding, releasedAt: sandbox.lifecycle.observedAt }
                : binding,
            )
          : [
              {
                id: BindingIdSchema.parse(this.#createId()),
                sessionId,
                sandboxId: sandbox.id,
                role: 'primary' as const,
                ordinal: 0,
                boundAt: sandbox.lifecycle.observedAt,
                releasedAt: destroyed ? sandbox.lifecycle.observedAt : null,
              },
            ]
      next.sandboxes[sandbox.id] = sandbox
      next.operations[operation.id] = operation
      delete next.pendingCreateSpecs[operation.id]
      next.sessions[sessionId] = SessionSchema.parse({
        ...session,
        state: target,
        bindings,
        currentOperationId: null,
        providerVerifiedAt: sandbox.lifecycle.observedAt,
        sandboxDeletionVerifiedAt: destroyed ? sandbox.lifecycle.observedAt : null,
        updatedAt: sandbox.lifecycle.observedAt,
      })
      return next
    })
    return this.#view(sessionId)
  }

  async #recordFailure(sessionId: Session['id'], operation: Operation, error: unknown) {
    const ambiguous =
      error instanceof OcboxError &&
      ['PROVIDER_TIMEOUT', 'OPERATION_TIMEOUT', 'OPERATION_CANCELLED'].includes(error.code)
    if (ambiguous) return
    const completedAt = this.#timestamp()
    await this.#update((current) => {
      const next = copyState(current)
      const session = next.sessions[sessionId]
      if (session?.currentOperationId !== operation.id) return next
      next.operations[operation.id] = OperationSchema.parse({
        ...operation,
        status: 'failed',
        completedAt,
      })
      next.sessions[sessionId] = SessionSchema.parse({
        ...session,
        state: 'error',
        currentOperationId: null,
        updatedAt: completedAt,
      })
      return next
    })
  }

  async #view(sessionId: Session['id']) {
    return this.#viewFromState(await this.#store.load(), sessionId)
  }

  async #viewFromState(state: LifecycleProjectState, sessionId: Session['id']) {
    const session = state.sessions[sessionId]
    if (session === undefined) throw this.#notFound(sessionId)
    const binding = session.bindings.find((candidate) => candidate.releasedAt === null)
    const sandbox = binding === undefined ? null : (state.sandboxes[binding.sandboxId] ?? null)
    const operation =
      session.currentOperationId === null
        ? null
        : (state.operations[session.currentOperationId] ?? null)
    const requestId = RequestIdSchema.parse(this.#createId())
    const capabilities = await this.#provider(requestId).capabilities({
      requestId,
      issuedAt: this.#timestamp(),
    })
    return {
      selected: state.activeSessionId === sessionId,
      session,
      sandbox,
      operation,
      capabilities,
    }
  }

  async #resolveSession(sessionId?: string): Promise<Session> {
    const state = await this.#store.load()
    const id = sessionId === undefined ? state.activeSessionId : SessionIdSchema.parse(sessionId)
    if (id === null) {
      throw new OcboxError({
        code: 'ENVIRONMENT_NOT_FOUND',
        message: 'No Session is selected; run ocbox start or ocbox use SESSION_ID',
        requestId: RequestIdSchema.parse(this.#createId()),
      })
    }
    const session = state.sessions[id]
    if (session === undefined) throw this.#notFound(id)
    return session
  }

  async #withResolvedSession<Result>(
    sessionId: string | undefined,
    action: (session: Session) => Promise<Result>,
  ) {
    return action(await this.#resolveSession(sessionId))
  }

  #sandboxFor(state: LifecycleProjectState, session: Session): Sandbox {
    const binding = session.bindings.find((candidate) => candidate.releasedAt === null)
    const sandbox = binding === undefined ? undefined : state.sandboxes[binding.sandboxId]
    if (sandbox === undefined)
      throw this.#invalidState(session, 'Primary Sandbox binding is missing')
    return sandbox
  }

  #provider(requestId: ReturnType<typeof RequestIdSchema.parse>) {
    return this.#registry.resolve(this.#config.provider.name, requestId)
  }

  #allowedStates(action: Exclude<LifecycleAction, 'create'>): readonly Session['state'][] {
    switch (action) {
      case 'pause':
        return ['active']
      case 'stop':
        return ['active', 'paused', 'stopped']
      case 'destroy':
        return ['active', 'paused', 'stopped', 'error']
      case 'resume':
        return ['paused']
      case 'start':
        return ['stopped']
    }
  }

  async #update(
    mutate: (current: LifecycleProjectState) => LifecycleProjectState,
    requestId = RequestIdSchema.parse(this.#createId()),
  ): Promise<LifecycleProjectState> {
    try {
      return await this.#store.update(mutate, this.#signal)
    } catch (error) {
      if (error instanceof AtomicStoreCancelledError) throw this.#cancelled(requestId)
      if (error instanceof AtomicStoreConflictError) {
        throw new OcboxError({
          code: 'OPERATION_CONFLICT',
          message: 'Another lifecycle command is updating project state; retry this command',
          requestId,
        })
      }
      throw error
    }
  }

  async #abortable<Result>(promise: Promise<Result>, requestId: Operation['requestId']) {
    if (this.#signal === undefined) return promise
    if (this.#signal.aborted) throw this.#cancelled(requestId)
    const signal = this.#signal
    return promise.catch((error: unknown) => {
      throw signal.aborted ? this.#cancelled(requestId) : error
    })
  }

  #cancelled(requestId: Operation['requestId']) {
    return new OcboxError({
      code: 'OPERATION_CANCELLED',
      message: 'Lifecycle operation was cancelled; rerun the same command to reconcile it',
      requestId,
    })
  }

  #notFound(sessionId: Session['id']) {
    return new OcboxError({
      code: 'ENVIRONMENT_NOT_FOUND',
      message: `Session ${sessionId} was not found`,
      requestId: RequestIdSchema.parse(this.#createId()),
      details: { sessionId },
    })
  }

  #invalidState(session: Session, message?: string) {
    return new OcboxError({
      code: 'INVALID_STATE',
      message: message ?? `Session ${session.id} cannot perform this lifecycle transition`,
      requestId: RequestIdSchema.parse(this.#createId()),
      details: { sessionId: session.id, state: session.state },
    })
  }

  #conflict(session: Session, requestedAction: OperationAction) {
    return new OcboxError({
      code: 'OPERATION_CONFLICT',
      message: `Session ${session.id} already has a different lifecycle operation`,
      requestId: RequestIdSchema.parse(this.#createId()),
      details: { sessionId: session.id, requestedAction },
    })
  }
}

export function projectIdForPath(path: string): ProjectId {
  // UUID-shaped deterministic identifier derived from the complete normalized path.
  const normalizedPath = /^[A-Za-z]:[\\/]/.test(path) ? path.toLowerCase() : path
  const bytes = createHash('sha256').update(normalizedPath).digest('hex').slice(0, 32)
  return ProjectIdSchema.parse(
    `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-4${bytes.slice(13, 16)}-8${bytes.slice(17, 20)}-${bytes.slice(20, 32)}`,
  )
}

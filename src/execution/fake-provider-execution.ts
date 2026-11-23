import {
  OperationSchema,
  type CancelExecutionRequest,
  type ExecHandle,
  type ExecRequest,
  type Operation,
  type OperationContext,
  type ProviderExecution,
  type SandboxId,
  type SessionId,
} from '../contracts.js'
import {
  LocalProcessExecutionHarness,
  type LocalProcessHarnessOptions,
} from './local-process-harness.js'

export interface FakeProviderExecutionOptions extends LocalProcessHarnessOptions {
  /** Resolves the owning Session for a Sandbox; the fake provider reads persisted state. */
  readonly sessionIdForSandbox: (sandboxId: SandboxId) => SessionId | Promise<SessionId>
  readonly rejectCancellation?: boolean
}

interface ActiveExecution {
  readonly cancel: () => void
  readonly sandboxId: SandboxId
}

/** Fake provider execution port backed by the explicitly host-local contract harness. */
export class FakeProviderExecution implements ProviderExecution {
  readonly #harness: LocalProcessExecutionHarness
  readonly #sessionIdForSandbox: (sandboxId: SandboxId) => SessionId | Promise<SessionId>
  readonly #rejectCancellation: boolean
  readonly #active = new Map<string, ActiveExecution>()

  constructor(options: FakeProviderExecutionOptions) {
    this.#harness = new LocalProcessExecutionHarness(options)
    this.#sessionIdForSandbox = options.sessionIdForSandbox
    this.#rejectCancellation = options.rejectCancellation ?? false
  }

  async execute(context: OperationContext, request: ExecRequest): Promise<ExecHandle> {
    const local = this.#harness.execute(context, request)
    const executionId = local.handle.execution.id
    this.#active.set(executionId, { cancel: local.cancel, sandboxId: request.sandboxId })
    void local.handle.result.then(
      () => this.#active.delete(executionId),
      () => this.#active.delete(executionId),
    )
    return local.handle
  }

  async cancel(context: OperationContext, request: CancelExecutionRequest): Promise<Operation> {
    if (this.#rejectCancellation) return Promise.reject(new Error('Injected cancellation failure'))
    const active = this.#active.get(request.executionId)
    if (active === undefined) return Promise.reject(new Error('Execution is not active'))
    active.cancel()
    const completedAt = new Date().toISOString()
    const sessionId = await this.#sessionIdForSandbox(active.sandboxId)
    return OperationSchema.parse({
      id: context.operationId,
      requestId: context.requestId,
      sessionId,
      sandboxId: active.sandboxId,
      action: 'exec_cancel',
      status: 'succeeded',
      idempotencyKey: context.idempotencyKey,
      idempotencyResolution: { kind: 'created' },
      providerVerifiedAt: null,
      createdAt: context.issuedAt,
      startedAt: context.issuedAt,
      completedAt,
    })
  }
}

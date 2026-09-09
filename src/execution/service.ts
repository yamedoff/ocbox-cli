import { randomUUID } from 'node:crypto'
import {
  ExecRequestSchema,
  ExecutionSchema,
  IdempotencyKeySchema,
  OperationIdSchema,
  RequestIdSchema,
  type ExecEvent,
  type ExecHandle,
  type OperationAction,
  type OperationContext,
  type ProviderCapabilities,
  type Sandbox,
  type SandboxProvider,
  type Session,
  UtcTimestampSchema,
} from '../contracts.js'
import { findSensitiveMaterial } from '../security/redaction.js'
import type { ParsedExecArguments } from './cli-arguments.js'
import {
  ExecutionInfrastructureError,
  outcomeForResult,
  type ExecutionOutcome,
} from './exit-policy.js'
import { consumeExecutionOutput, type CapturedExecutionOutput } from './stream-output.js'

export interface ExecutionTarget {
  readonly session: Session
  readonly sandbox: Sandbox | null
  readonly capabilities: ProviderCapabilities
  readonly provider: SandboxProvider
}

export interface ExecutionServiceOptions {
  readonly createId?: () => string
  readonly now?: () => Date
  readonly retainedBytesPerStream?: number
}

export interface ExecutionCompletion {
  readonly outcome: ExecutionOutcome
  readonly output: CapturedExecutionOutput | null
}

export interface ExecutionRun {
  readonly completion: Promise<ExecutionCompletion>
  interrupt(): Promise<'cancel_requested' | 'force_exit'>
}

export class ExecutionContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecutionContextError'
  }
}

/** Validates context before the provider execution mutation is invoked. */
function validateTarget(target: ExecutionTarget, arguments_: ParsedExecArguments): void {
  if (target.session.state !== 'active') {
    throw new ExecutionContextError('The selected Session must be active before execution')
  }
  if (target.sandbox === null || target.sandbox.lifecycle.normalizedState !== 'running') {
    throw new ExecutionContextError('The selected Session does not have a ready running sandbox')
  }
  if (arguments_.sessionId !== null && arguments_.sessionId !== target.session.id) {
    throw new ExecutionContextError('The requested Session does not match the selected Session')
  }
  const activeBinding = target.session.bindings.find((binding) => binding.releasedAt === null)
  if (
    activeBinding === undefined ||
    activeBinding.role !== 'primary' ||
    activeBinding.sandboxId !== target.sandbox.id ||
    target.sandbox.projectId !== target.session.projectId
  ) {
    throw new ExecutionContextError('The selected Session does not have a valid primary Sandbox')
  }
  if (!target.capabilities.execution.streaming) {
    throw new ExecutionContextError('The selected provider does not support streaming execution')
  }
  if (!target.capabilities.execution.cancellation) {
    throw new ExecutionContextError('The selected provider does not support execution cancellation')
  }
  if (
    arguments_.timeoutMilliseconds !== null &&
    target.capabilities.limits.maxExecutionMilliseconds !== null &&
    arguments_.timeoutMilliseconds > target.capabilities.limits.maxExecutionMilliseconds
  ) {
    throw new ExecutionContextError('The requested timeout exceeds the provider limit')
  }
  if (
    arguments_.command.mode === 'shell' &&
    target.sandbox.specification.effective?.operatingSystem !== 'linux'
  ) {
    throw new ExecutionContextError('Explicit shell mode requires a Bash-compatible Linux image')
  }
  if (
    findSensitiveMaterial(arguments_.environment).some(
      (finding) => finding.kind === 'credential-field' || finding.kind === 'credential-value',
    )
  ) {
    throw new ExecutionContextError('Execution environment accepts non-secret settings only')
  }
}

/** Provider-neutral execution coordinator with a two-stage Ctrl-C state machine. */
export class ExecutionService {
  readonly #createId: () => string
  readonly #now: () => Date
  readonly #retainedBytesPerStream: number

  constructor(options: ExecutionServiceOptions = {}) {
    this.#createId = options.createId ?? randomUUID
    this.#now = options.now ?? (() => new Date())
    this.#retainedBytesPerStream = options.retainedBytesPerStream ?? 65_536
  }

  async start(
    target: ExecutionTarget,
    arguments_: ParsedExecArguments,
    sink: (event: ExecEvent) => Promise<void>,
  ): Promise<ExecutionRun> {
    validateTarget(target, arguments_)
    const request = ExecRequestSchema.parse({
      sandboxId: target.sandbox?.id,
      command: arguments_.command,
      workingDirectory: arguments_.workingDirectory,
      timeoutMilliseconds: arguments_.timeoutMilliseconds,
      environment: arguments_.environment,
    })
    const context = this.#context('exec')
    let handle: ExecHandle
    try {
      handle = await target.provider.exec.execute(context, request)
    } catch (error) {
      throw new ExecutionInfrastructureError('provider_start', error)
    }
    const execution = ExecutionSchema.safeParse(handle.execution)
    if (
      !execution.success ||
      execution.data.operationId !== context.operationId ||
      execution.data.sandboxId !== request.sandboxId ||
      JSON.stringify(execution.data.command) !== JSON.stringify(request.command) ||
      !['queued', 'running'].includes(execution.data.status)
    ) {
      throw new ExecutionInfrastructureError('provider_start')
    }
    let interrupts = 0
    let interrupted = false
    let cancellation: Promise<void> | undefined

    const requestRemoteCancellation = (): Promise<void> => {
      cancellation ??= target.provider.exec
        .cancel(this.#context('exec_cancel'), { executionId: handle.execution.id })
        .then(() => undefined)
      return cancellation
    }

    const completion = (async (): Promise<ExecutionCompletion> => {
      try {
        const output = await consumeExecutionOutput(
          handle.execution.id,
          handle.events,
          sink,
          this.#retainedBytesPerStream,
        )
        const providerResult = await handle.result
        if (
          providerResult.exitCode !== output.result.exitCode ||
          providerResult.signal !== output.result.signal ||
          providerResult.startedAt !== output.result.startedAt ||
          providerResult.completedAt !== output.result.completedAt ||
          providerResult.timedOut !== output.result.timedOut ||
          providerResult.cancelled !== output.result.cancelled
        ) {
          throw new ExecutionInfrastructureError('provider_result')
        }
        return { outcome: outcomeForResult(output.result), output }
      } catch (error) {
        try {
          await requestRemoteCancellation()
        } catch {
          // Cleanup is best-effort; the original terminal classification remains authoritative.
        }
        return {
          outcome: interrupted
            ? { kind: 'cancelled', result: null }
            : {
                kind: 'infrastructure_error',
                error:
                  error instanceof ExecutionInfrastructureError
                    ? error
                    : new ExecutionInfrastructureError('event_stream', error),
              },
          output: null,
        }
      }
    })()

    return {
      completion,
      interrupt: async () => {
        interrupts++
        interrupted = true
        if (interrupts > 1) return 'force_exit'
        try {
          await requestRemoteCancellation()
        } catch {
          // A repeated interrupt still exits 130; otherwise the terminal stream remains authoritative.
        }
        return 'cancel_requested'
      },
    }
  }

  #context(action: Extract<OperationAction, 'exec' | 'exec_cancel'>): OperationContext {
    const requestId = RequestIdSchema.parse(this.#createId())
    const operationId = OperationIdSchema.parse(this.#createId())
    return {
      requestId,
      operationId,
      issuedAt: UtcTimestampSchema.parse(this.#now().toISOString()),
      idempotencyKey: IdempotencyKeySchema.parse(`${action}:${operationId}`),
      attempt: 1,
    }
  }
}

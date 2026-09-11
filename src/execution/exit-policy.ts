import type { ExecResult } from '../contracts.js'

export type ExecutionInfrastructureStage =
  | 'before_start'
  | 'provider_start'
  | 'event_stream'
  | 'provider_result'

/** Safe typed error for provider, transport, or stream failures around an execution. */
export class ExecutionInfrastructureError extends Error {
  readonly code = 'EXECUTION_INFRASTRUCTURE_ERROR'
  readonly stage: ExecutionInfrastructureStage

  constructor(stage: ExecutionInfrastructureStage, cause?: unknown) {
    super('Execution infrastructure failed', cause === undefined ? undefined : { cause })
    this.name = 'ExecutionInfrastructureError'
    this.stage = stage
  }
}

export type ExecutionOutcome =
  | { readonly kind: 'remote_result'; readonly result: ExecResult }
  | { readonly kind: 'timeout'; readonly result: ExecResult }
  | { readonly kind: 'cancelled'; readonly result: ExecResult | null }
  | {
      readonly kind: 'infrastructure_error'
      readonly error: ExecutionInfrastructureError
      /**
       * Curated code/message from a typed `OcboxError` detected before a remote
       * process started. It is optional so infrastructure failures with no safe
       * typed classification keep the original generic envelope.
       */
      readonly detail?: ExecutionOutcomeDetail
    }

/** Safe, already-redacted classification surfaced for pre-start target failures. */
export interface ExecutionOutcomeDetail {
  readonly code: string
  readonly message: string
}

export function outcomeForResult(result: ExecResult): ExecutionOutcome {
  if (result.timedOut) return { kind: 'timeout', result }
  if (result.cancelled) return { kind: 'cancelled', result }
  return { kind: 'remote_result', result }
}

/** Normative CLI exit mapping; structured output carries the outcome discriminator. */
export function exitCodeForExecution(outcome: ExecutionOutcome): number {
  switch (outcome.kind) {
    case 'remote_result':
      return outcome.result.exitCode
    case 'timeout':
      return 124
    case 'infrastructure_error':
      return 125
    case 'cancelled':
      return 130
  }
}

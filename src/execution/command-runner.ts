import { OcboxError } from '../errors/index.js'
import type { ExecEvent } from '../contracts.js'
import {
  ExecArgumentError,
  parseExecArguments,
  type ExecutionOutputMode,
  type ParsedExecArguments,
} from './cli-arguments.js'
import {
  ExecutionInfrastructureError,
  exitCodeForExecution,
  type ExecutionOutcome,
  type ExecutionOutcomeDetail,
} from './exit-policy.js'
import {
  createExecutionEventSink,
  writeExecutionCompletion,
  type ExecutionWritable,
} from './output.js'
import {
  ExecutionService,
  type ExecutionCompletion,
  type ExecutionRun,
  ExecutionContextError,
  type ExecutionServiceOptions,
  type ExecutionTarget,
} from './service.js'

export interface ExecutionCommandIo {
  readonly stdout: ExecutionWritable
  readonly stderr: ExecutionWritable
}

/** Thrown when a closed execution stream still tries to emit an event. */
export class ExecutionStreamEndedError extends Error {
  constructor() {
    super('Execution event stream was closed before a terminal result')
    this.name = 'ExecutionStreamEndedError'
  }
}

/**
 * Wraps a terminal outcome sink so event emission stops deterministically once
 * the streaming boundary is closed by the caller (for example, right after a
 * repeated Ctrl-C has already produced the final envelope).
 */
function gatedSink(
  sink: (event: ExecEvent) => Promise<void>,
  acceptExtraEvent: () => boolean,
): (event: ExecEvent) => Promise<void> {
  return async (event) => {
    acceptExtraEvent()
    await sink(event)
  }
}

export interface ExecutionInterruptSource {
  subscribe(listener: () => void): () => void
}

export type ExecutionTargetResolver = (
  arguments_: ParsedExecArguments,
) => ExecutionTarget | Promise<ExecutionTarget>

export interface ExecutionCommandOptions extends ExecutionServiceOptions {
  readonly interrupts?: ExecutionInterruptSource
}

/** Process signal adapter used by the eventual oclif command entrypoint. */
export const processInterrupts: ExecutionInterruptSource = {
  subscribe(listener) {
    process.on('SIGINT', listener)
    return () => process.removeListener('SIGINT', listener)
  },
}

function requestedOutputMode(input: readonly string[]): ExecutionOutputMode {
  let mode: ExecutionOutputMode = 'human'
  for (const value of input) {
    if (value === '--') break
    if (value === '--json') mode = 'json'
    if (value === '--jsonl') mode = 'jsonl'
  }
  return mode
}

function beforeStartFailure(error: unknown): ExecutionCompletion {
  const detail = safeOutcomeDetail(error)
  return {
    outcome: {
      kind: 'infrastructure_error',
      error:
        error instanceof ExecutionInfrastructureError
          ? error
          : new ExecutionInfrastructureError('before_start', error),
      ...(detail === undefined ? {} : { detail }),
    },
    output: null,
  }
}

/**
 * Extracts an actionable, already-redacted classification from a typed
 * `OcboxError` (or an ExecutionInfrastructureError wrapping one) without
 * exposing raw causes, provider text, local paths, or command output. The
 * execution-owned typed argument/context errors are user-caused validation
 * failures whose static messages are safe to surface verbatim; everything else
 * keeps the generic unexplained envelope.
 */
function safeOutcomeDetail(error: unknown): ExecutionOutcomeDetail | undefined {
  const safe =
    error instanceof ExecArgumentError
      ? { code: 'EXECUTION_ARGUMENT_INVALID', message: error.message }
      : error instanceof ExecutionContextError
        ? { code: 'EXECUTION_CONTEXT_INVALID', message: error.message }
        : undefined
  if (safe !== undefined) return safe
  const candidate =
    error instanceof OcboxError
      ? error
      : error instanceof Error && error.cause instanceof OcboxError
        ? error.cause
        : undefined
  return candidate === undefined ? undefined : { code: candidate.code, message: candidate.message }
}

/**
 * Complete provider-neutral `ocbox exec` flow. The caller resolves the selected
 * Session/provider target; this runner owns parsing, streaming, Ctrl-C, and exit policy.
 */
export async function runExecutionCommand(
  input: readonly string[],
  resolveTarget: ExecutionTargetResolver,
  io: ExecutionCommandIo,
  options: ExecutionCommandOptions = {},
): Promise<number> {
  let mode = requestedOutputMode(input)
  let arguments_: ParsedExecArguments
  let run: ExecutionRun
  /**
   * Once a terminal envelope has been handed to the caller, streaming is closed:
   * later event emissions must stop. The gate is what keeps a stuck or
   * unobservable run after a repeated interrupt from appending events after the
   * final JSONL/JSON envelope and from keeping the underlying pump alive.
   */
  let terminalStreamAccepted = false
  try {
    arguments_ = parseExecArguments(input)
    mode = arguments_.outputMode
    const target = await resolveTarget(arguments_)
    const service = new ExecutionService(options)
    run = await service.start(
      target,
      arguments_,
      gatedSink(createExecutionEventSink(mode, io.stdout, io.stderr), () => {
        if (terminalStreamAccepted) {
          throw new ExecutionInfrastructureError('event_stream', new ExecutionStreamEndedError())
        }
        return true
      }),
    )
  } catch (error) {
    const completion = beforeStartFailure(error)
    await writeExecutionCompletion(mode, completion, io.stdout, io.stderr)
    return exitCodeForExecution(completion.outcome)
  }

  let forceExit: ((completion: ExecutionCompletion) => void) | undefined
  const repeatedInterrupt = new Promise<ExecutionCompletion>((resolve) => {
    forceExit = resolve
  })
  let terminal = false
  const onInterrupt = (): void => {
    void run.interrupt().then((action) => {
      if (action === 'force_exit' && !terminal) {
        const outcome: ExecutionOutcome = { kind: 'cancelled', result: null }
        forceExit?.({ outcome, output: null })
      }
    })
  }
  const dispose = options.interrupts?.subscribe(onInterrupt) ?? (() => {})
  try {
    const completion = await Promise.race([run.completion, repeatedInterrupt])
    terminal = true
    terminalStreamAccepted = true
    await writeExecutionCompletion(mode, completion, io.stdout, io.stderr)
    return exitCodeForExecution(completion.outcome)
  } finally {
    dispose()
  }
}

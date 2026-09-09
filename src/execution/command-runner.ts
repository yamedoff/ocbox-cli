import {
  parseExecArguments,
  type ExecutionOutputMode,
  type ParsedExecArguments,
} from './cli-arguments.js'
import {
  ExecutionInfrastructureError,
  exitCodeForExecution,
  type ExecutionOutcome,
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
  type ExecutionServiceOptions,
  type ExecutionTarget,
} from './service.js'

export interface ExecutionCommandIo {
  readonly stdout: ExecutionWritable
  readonly stderr: ExecutionWritable
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
  return {
    outcome: {
      kind: 'infrastructure_error',
      error:
        error instanceof ExecutionInfrastructureError
          ? error
          : new ExecutionInfrastructureError('before_start', error),
    },
    output: null,
  }
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
  try {
    arguments_ = parseExecArguments(input)
    mode = arguments_.outputMode
    const target = await resolveTarget(arguments_)
    const service = new ExecutionService(options)
    run = await service.start(
      target,
      arguments_,
      createExecutionEventSink(mode, io.stdout, io.stderr),
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
    await writeExecutionCompletion(mode, completion, io.stdout, io.stderr)
    return exitCodeForExecution(completion.outcome)
  } finally {
    dispose()
  }
}

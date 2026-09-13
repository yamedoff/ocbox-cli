import { Args, Flags } from '@oclif/core'
import {
  buildClaudeDenyDecision,
  type ClaudeHookDenyDecision,
  type ClaudeHookExecResult,
  guardDenyReason,
  runClaudeRoutingHook,
} from '../../agents/claude-code/hook.js'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'
import { createLifecycleService, type RuntimeFlags } from '../../cli/runtime.js'
import {
  processInterrupts,
  runExecutionCommandResult,
  type ExecutionCommandIo,
} from '../../execution/index.js'
import { redactForOutput } from '../../security/redaction.js'

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The hook owns stdout for its single PreToolUse JSON decision, so routed command
 * output is redirected to stderr. That keeps the remote stdout/stderr visible to
 * the user without corrupting the machine-readable hook decision on stdout.
 */
function hookCommandIo(io: ExecutionCommandIo): ExecutionCommandIo {
  return { stdout: io.stderr, stderr: io.stderr }
}

/**
 * Builds the hook's `ocbox exec` invocation. It returns the structured result so
 * the hook can report the honest remote outcome (including a legitimate remote
 * exit 2) and distinguish it from this adapter's own pre-start block. Pre-start
 * argument and Session resolution failures are reported as `started: false` and
 * blocked by the hook, never left to fall through to local execution.
 */
export function createClaudeHookInvoker(
  runtime: RuntimeFlags,
  io: ExecutionCommandIo,
): (argv: readonly string[]) => Promise<ClaudeHookExecResult> {
  const routedIo = hookCommandIo(io)
  return async (argv) => {
    const result = await runExecutionCommandResult(
      argv.slice(1),
      async (parsed) =>
        (await createLifecycleService(runtime)).executionTarget(parsed.sessionId ?? undefined),
      routedIo,
      { interrupts: processInterrupts },
    )
    return { started: result.started, exitCode: result.exitCode, outcome: result.outcome.kind }
  }
}

/**
 * Injectable surface for the fail-closed hook boundary. Everything the boundary
 * touches (stdin reader, exec invoker, writers) is a dependency so the
 * unexpected-error paths can be exercised without a real stream or process exit.
 */
export interface AgentHookSafetyDeps {
  readonly adapter: string
  readonly readInput: () => Promise<string>
  readonly sessionId: string | null
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly invokeExec: (argv: readonly string[]) => Promise<ClaudeHookExecResult>
  readonly writeError: (message: string) => void
  readonly writeDecision: (decision: ClaudeHookDenyDecision) => void
}

/**
 * Redacts an unexpected error before it crosses the hook boundary. A thrown
 * error can carry a credential or a host-local path, and the hook's decision
 * reason and stderr are captured by Claude Code, so the detail is passed through
 * the same recursive redaction the rest of the CLI uses.
 */
function safeGuardReason(message: string): string {
  const redacted = redactForOutput(message)
  return guardDenyReason(typeof redacted === 'string' ? redacted : 'unexpected hook error')
}

/**
 * Best-effort guard emission. Each writer is attempted independently and its
 * failure is swallowed: a closed stdout/stderr must never rethrow, and a failed
 * `writeDecision` must never be retried as a second execution claim. The caller
 * still returns exit 2, which keeps the covered local Bash copy blocked.
 */
function emitGuardDeny(deps: AgentHookSafetyDeps, reason: string): void {
  try {
    deps.writeError(reason)
  } catch {
    // The process is failing closed regardless of whether stderr is writable.
  }
  try {
    deps.writeDecision(buildClaudeDenyDecision(reason))
  } catch {
    // Do not retry a decision write; there is no second execution to report.
  }
}

/**
 * Top-level fail-closed boundary for `ocbox agent hook`.
 *
 * Claude Code treats a PreToolUse hook exit other than 2 as a non-blocking
 * warning, so an uncaught generic error (exit 1) would let a covered Bash call
 * run locally after `ocbox` already ran it. This wrapper therefore converts any
 * unexpected error while reading stdin, deciding routing, invoking `ocbox exec`,
 * or writing the decision into the documented `ocbox-block[guard]` denial with
 * exit 2. A decision-writer failure is caught here rather than escaping, and is
 * never followed by a second invoked execution.
 */
export async function runAgentHookSafely(deps: AgentHookSafetyDeps): Promise<number> {
  if (deps.adapter !== 'claude-code') {
    try {
      deps.writeError(`unknown adapter "${deps.adapter}"; only "claude-code" is supported`)
    } catch {
      // Preserve the fail-closed exit code even when stderr is unavailable.
    }
    return 2
  }
  try {
    return await runClaudeRoutingHook({
      rawInput: await deps.readInput(),
      sessionId: deps.sessionId,
      environment: deps.environment,
      invokeExec: deps.invokeExec,
      writeError: deps.writeError,
      writeDecision: deps.writeDecision,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    emitGuardDeny(
      deps,
      safeGuardReason(`unexpected hook process error (${detail}); failing closed (exit 2)`),
    )
    return 2
  }
}

/**
 * Adapter-owned hook entrypoint. Claude Code pipes the PreToolUse JSON on
 * stdin; this command applies fail-closed routing, runs the selected Session
 * through the same `ocbox exec` runner as the CLI command, and then emits the
 * documented blocking `permissionDecision: "deny"` so the original local Bash
 * copy never executes a second time.
 */
export default class AgentHook extends OcboxCommand {
  static override description =
    'Internal claude-code hook entrypoint (reads PreToolUse JSON from stdin)'
  static override args = {
    adapter: Args.string({ required: true, description: 'Adapter name (only claude-code)' }),
  }
  static override flags = {
    ...runtimeFlags,
    session: Flags.string({ description: 'Selected Session ID for covered shell routing' }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentHook)
    const runtime: RuntimeFlags = flags
    const io: ExecutionCommandIo = { stdout: process.stdout, stderr: process.stderr }
    process.exitCode = await runAgentHookSafely({
      adapter: String(args.adapter ?? ''),
      readInput: readStandardInput,
      sessionId: flags.session ?? null,
      environment: process.env,
      invokeExec: createClaudeHookInvoker(runtime, io),
      writeError: (message) => {
        process.stderr.write(`${message}\n`)
      },
      writeDecision: (decision) => {
        process.stdout.write(`${JSON.stringify(decision)}\n`)
      },
    })
  }
}

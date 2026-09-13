import { Args, Flags } from '@oclif/core'
import { type ClaudeHookExecResult, runClaudeRoutingHook } from '../../agents/claude-code/hook.js'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'
import { createLifecycleService, type RuntimeFlags } from '../../cli/runtime.js'
import {
  processInterrupts,
  runExecutionCommandResult,
  type ExecutionCommandIo,
} from '../../execution/index.js'

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
    const adapter = String(args.adapter ?? '')
    if (adapter !== 'claude-code') {
      process.stderr.write(`unknown adapter "${adapter}"; only "claude-code" is supported\n`)
      process.exitCode = 2
      return
    }
    const runtime: RuntimeFlags = flags
    const io: ExecutionCommandIo = { stdout: process.stdout, stderr: process.stderr }
    const exitCode = await runClaudeRoutingHook({
      rawInput: await readStandardInput(),
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
    process.exitCode = exitCode
  }
}

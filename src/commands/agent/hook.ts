import { Args, Flags } from '@oclif/core'
import { runClaudeRoutingHook } from '../../agents/claude-code/hook.js'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'
import { createLifecycleService, type RuntimeFlags } from '../../cli/runtime.js'
import {
  processInterrupts,
  runExecutionCommand,
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
 * Adapter-owned hook entrypoint. Claude Code pipes the PreToolUse JSON on
 * stdin; this command applies fail-closed routing and only then runs the
 * selected Session through the same `ocbox exec` runner as the CLI command.
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
      invokeExec: async (argv) =>
        runExecutionCommand(
          argv.slice(1),
          async (parsed) =>
            (await createLifecycleService(runtime)).executionTarget(parsed.sessionId ?? undefined),
          io,
          { interrupts: processInterrupts },
        ),
      writeError: (message) => {
        process.stderr.write(`${message}\n`)
      },
    })
    process.exitCode = exitCode
  }
}

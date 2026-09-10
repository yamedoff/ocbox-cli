import { Flags } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { createLifecycleService, type RuntimeFlags } from '../cli/runtime.js'
import {
  processInterrupts,
  runExecutionCommand,
  type ExecutionCommandIo,
} from '../execution/index.js'

const HOST_VALUE_FLAGS = new Set(['config', 'state-dir'])
const HOST_BOOLEAN_FLAGS = new Set(['no-color'])

/**
 * Returns the execution-owned tokens from the raw command line. oclif consumes
 * the host runtime flags that select configuration/state; the versioned exec
 * grammar — including a literal `--` and every token after it — is owned by the
 * execution parser, so those host flags are removed before it sees the stream.
 */
export function executionTokens(argv: readonly string[]): string[] {
  const tokens: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) break
    if (token === '--') {
      tokens.push(...argv.slice(index))
      break
    }
    const match = /^--([^=]+)(?:=(.*))?$/.exec(token)
    if (match !== null && match[1] !== undefined) {
      if (HOST_BOOLEAN_FLAGS.has(match[1])) continue
      if (HOST_VALUE_FLAGS.has(match[1])) {
        if (match[2] === undefined) index += 1
        continue
      }
    }
    tokens.push(token)
  }
  return tokens
}

/**
 * `ocbox exec` never invokes a local shell. Structured argv is carried unchanged
 * to the execution runner, which drives the provider-neutral streaming/exit
 * contract. Host flags are parsed only for config/state discovery.
 */
export default class Exec extends OcboxCommand {
  static override description = 'Execute a program in the selected Session Sandbox'
  static override strict = false
  static override flags = {
    ...runtimeFlags,
    session: Flags.string({ description: 'Session ID; defaults to the selected Session' }),
    cwd: Flags.string({ description: 'Normalized absolute sandbox working directory' }),
    timeout: Flags.string({ description: 'Positive execution timeout in milliseconds' }),
    env: Flags.string({ multiple: true, description: 'Repeatable non-secret NAME=VALUE setting' }),
    shell: Flags.string({ description: 'Explicit /bin/bash -lc command string' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Exec)
    const runtime: RuntimeFlags = flags
    const io: ExecutionCommandIo = { stdout: process.stdout, stderr: process.stderr }
    const exitCode = await runExecutionCommand(
      executionTokens(this.argv),
      async (arguments_) =>
        (await createLifecycleService(runtime)).executionTarget(arguments_.sessionId ?? undefined),
      io,
      { interrupts: processInterrupts },
    )
    process.exitCode = exitCode
  }
}

import { resolve } from 'node:path'
import { Flags } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import {
  createLifecycleService,
  loadProjectConfig,
  type RuntimeFlags,
  resolveAccountStateDirectory,
  resolveStateDirectory,
} from '../cli/runtime.js'
import {
  type ExecutionCommandIo,
  processInterrupts,
  runExecutionCommand,
} from '../execution/index.js'
import { type LifecycleProjectState, LifecycleStore, projectIdForPath } from '../lifecycle/index.js'

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

/** Resolves the hosted ID recorded for a CLI-local execution ID, if any. */
export function hostedExecutionIdFromMappings(
  mappings: LifecycleProjectState['hostedMappings'],
  localExecutionId: string,
): string | undefined {
  for (const scope of Object.values(mappings)) {
    for (const mapping of Object.values(scope)) {
      if (mapping.lastLocalExecutionId === localExecutionId) return mapping.lastExecutionId
    }
  }
  return undefined
}

/**
 * Lazily builds the lifecycle service and the store that records the hosted
 * execution mapping. `ocbox execution get` reads the hosted API directly, so
 * `exec` must print the hosted ID rather than the CLI-local event ID.
 */
async function lifecycleContext(runtime: RuntimeFlags): Promise<{
  readonly service: Awaited<ReturnType<typeof createLifecycleService>>
  readonly store: LifecycleStore
}> {
  const config = await loadProjectConfig(runtime)
  const stateDirectory = resolveStateDirectory(runtime)
  const lifecycleStateDirectory = await resolveAccountStateDirectory(
    runtime,
    stateDirectory,
    config.provider.name === 'ocbox',
  )
  return {
    service: await createLifecycleService(runtime, undefined, lifecycleStateDirectory, {
      warmSessions: true,
    }),
    store: new LifecycleStore(lifecycleStateDirectory, projectIdForPath(resolve(process.cwd()))),
  }
}

/**
 * `ocbox exec` never invokes a local shell. Structured argv is carried unchanged
 * to the execution runner, which drives the provider-neutral streaming/exit
 * contract. Host flags are parsed only for config/state discovery.
 */
export default class Exec extends OcboxCommand {
  static override description =
    "Execute a program in the selected Session Sandbox; for example: ocbox exec -- npm test\n\nBy default commands run in the box's workspace folder, where `ocbox sync push` puts the files.\n\nTokens after `--` are passed to the remote program verbatim as a structured argv array; they are never evaluated by any shell. Use `--shell COMMAND` for an explicit Bash command string."
  static override usage = 'exec [flags] -- <command> [args...]'
  static override strict = false
  static override flags = {
    ...runtimeFlags,
    session: Flags.string({ description: 'Session ID; defaults to the selected Session' }),
    cwd: Flags.string({
      description:
        'Normalized absolute sandbox working directory; the hosted service refuses this flag, so omit it and use the box workspace (the default)',
    }),
    timeout: Flags.string({
      hidden: true,
      description:
        'Deprecated millisecond alias for `--timeout-seconds`, for example `--timeout 300000` is 5 minutes; it still works but warns',
    }),
    'timeout-seconds': Flags.string({
      description:
        'Positive execution timeout in seconds, for example `--timeout-seconds 300` is 5 minutes; sent to the hosted service as timeoutSeconds unchanged, and mutually exclusive with `--timeout`',
    }),
    env: Flags.string({
      multiple: true,
      description:
        'Repeatable non-secret NAME=VALUE setting; the hosted service refuses this flag, so omit it and set the value in the command or image',
    }),
    shell: Flags.string({ description: 'Explicit /bin/bash -lc command string' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Exec)
    const runtime: RuntimeFlags = flags
    const io: ExecutionCommandIo = { stdout: process.stdout, stderr: process.stderr }
    let context: ReturnType<typeof lifecycleContext> | undefined
    const current = (): ReturnType<typeof lifecycleContext> => {
      context ??= lifecycleContext(runtime)
      return context
    }
    const exitCode = await runExecutionCommand(
      executionTokens(this.argv),
      async (arguments_) =>
        (await current()).service.executionTarget(arguments_.sessionId ?? undefined),
      io,
      {
        interrupts: processInterrupts,
        resolveExecutionId: async (localExecutionId) => {
          try {
            const { store } = await current()
            const state = await store.load()
            return hostedExecutionIdFromMappings(state.hostedMappings, localExecutionId)
          } catch {
            // Fall back to the local ID rather than breaking execution output.
          }
          return undefined
        },
      },
    )
    process.exitCode = exitCode
  }
}

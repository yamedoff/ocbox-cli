import { Command, Flags } from '@oclif/core'
import { createOutputWriter, type RuntimeFlags } from './runtime.js'

export const runtimeFlags = {
  config: Flags.string({ description: 'Path to opencloudbox.toml' }),
  json: Flags.boolean({ description: 'Emit one stable JSON envelope' }),
  jsonl: Flags.boolean({ description: 'Emit one compact JSON envelope per line' }),
  'no-color': Flags.boolean({ description: 'Disable ANSI color' }),
  'state-dir': Flags.string({ description: 'Override the host-local state directory' }),
}

/** Shared output/error boundary for product commands. */
export abstract class OcboxCommand extends Command {
  protected async emitResult<Result>(
    flags: RuntimeFlags,
    name: string,
    humanMessage: (result: Result) => string,
    action: () => Promise<Result>,
  ): Promise<void> {
    const writer = createOutputWriter(flags, { stdout: process.stdout, stderr: process.stderr })
    try {
      const result = await action()
      writer.result(name, result, { humanMessage: humanMessage(result) })
    } catch (error) {
      writer.error(error)
      process.exitCode = 1
    }
  }

  protected abortOnInterrupt(): { readonly signal: AbortSignal; readonly dispose: () => void } {
    const controller = new AbortController()
    const abort = () => controller.abort()
    process.once('SIGINT', abort)
    return { signal: controller.signal, dispose: () => process.removeListener('SIGINT', abort) }
  }
}

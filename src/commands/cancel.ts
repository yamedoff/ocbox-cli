import { Args, Flags } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { createLifecycleService } from '../cli/runtime.js'

export default class Cancel extends OcboxCommand {
  static override description = 'Cancel a remote execution and wait for its final state'
  static override args = {
    'execution-id': Args.string({
      description: 'Hosted execution ID; defaults to the last execution of the selected Sandbox',
    }),
  }
  static override flags = {
    ...runtimeFlags,
    sandbox: Flags.string({
      description: 'Local Sandbox ID; defaults to the selected Session primary Sandbox',
    }),
    'wait-timeout': Flags.integer({
      min: 1,
      max: 2_147_483_647,
      default: 30_000,
      description: 'Maximum cancellation wait in milliseconds',
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Cancel)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(
        flags,
        'execution.cancelled',
        (result) => `Execution ${result.executionId}: ${result.state}`,
        async () =>
          (await createLifecycleService(flags, interrupt.signal)).cancelExecution(
            args['execution-id'],
            flags.sandbox,
            flags['wait-timeout'],
          ),
      )
    } finally {
      interrupt.dispose()
    }
  }
}

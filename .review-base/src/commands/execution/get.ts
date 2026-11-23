import { Args } from '@oclif/core'
import { OcboxCommand } from '../../cli/base-command.js'
import { executionLine, getExecution } from '../../hosted/execution.js'
import { createMetadataClient } from '../../metadata/client.js'
import { hostedFlags } from '../../metadata/command.js'

/** Read one hosted execution and its result when terminal. */
export default class ExecutionGet extends OcboxCommand {
  static override description = 'Read a hosted execution and its result when it has finished'
  static override args = {
    'execution-id': Args.string({
      required: true,
      description: 'Hosted execution ID returned by `ocbox exec`',
    }),
  }
  static override flags = hostedFlags

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecutionGet)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(flags, 'execution.inspected', executionLine, () =>
        getExecution(createMetadataClient(flags), args['execution-id'], interrupt.signal),
      )
    } finally {
      interrupt.dispose()
    }
  }
}

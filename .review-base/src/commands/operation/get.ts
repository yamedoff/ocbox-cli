import { Args } from '@oclif/core'
import { OcboxCommand } from '../../cli/base-command.js'
import { getOperation, operationLine } from '../../hosted/operation.js'
import { createMetadataClient } from '../../metadata/client.js'
import { hostedFlags } from '../../metadata/command.js'

/** Read one durable hosted operation. */
export default class OperationGet extends OcboxCommand {
  static override description = 'Read a durable hosted operation and its stored failure reason'
  static override args = {
    'operation-id': Args.string({
      required: true,
      description: 'Hosted operation ID returned by a box or source action',
    }),
  }
  static override flags = hostedFlags

  async run(): Promise<void> {
    const { args, flags } = await this.parse(OperationGet)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(
        flags,
        'operation.inspected',
        (result) => operationLine(result.operation),
        () => getOperation(createMetadataClient(flags), args['operation-id'], interrupt.signal),
      )
    } finally {
      interrupt.dispose()
    }
  }
}

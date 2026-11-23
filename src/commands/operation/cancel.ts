import { Args } from '@oclif/core'
import { OcboxCommand } from '../../cli/base-command.js'
import { idempotencyKey } from '../../hosted/idempotency.js'
import { cancelOperation, operationLine } from '../../hosted/operation.js'
import { createMetadataClient } from '../../metadata/client.js'
import { hostedFlags, mutationFlags } from '../../metadata/command.js'

/** Request cancellation of a cancellable hosted operation. */
export default class OperationCancel extends OcboxCommand {
  static override description = 'Cancel a cancellable hosted operation and return its new state'
  static override args = {
    'operation-id': Args.string({
      required: true,
      description: 'Hosted operation ID returned by a box or source action',
    }),
  }
  static override flags = {
    ...hostedFlags,
    ...mutationFlags,
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(OperationCancel)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(
        flags,
        'operation.cancelled',
        (result) => operationLine(result.operation),
        () =>
          cancelOperation(
            createMetadataClient(flags),
            args['operation-id'],
            idempotencyKey(flags['idempotency-key']),
            interrupt.signal,
          ),
      )
    } finally {
      interrupt.dispose()
    }
  }
}

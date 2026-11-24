import { Args } from '@oclif/core'
import { OcboxCommand } from '../../cli/base-command.js'
import { idempotencyKey } from '../../hosted/idempotency.js'
import { createMetadataClient } from '../../metadata/client.js'
import { mutationFlags } from '../../metadata/command.js'
import {
  resolveSnapshotSession,
  restoreSnapshotOperation,
  snapshotFlags,
  waitForSnapshotOperation,
} from './index.js'

export default class SnapshotRestore extends OcboxCommand {
  static override description = 'Restore a Session from one of its snapshots and wait for it'
  static override args = {
    'snapshot-id': Args.string({
      required: true,
      description: 'Snapshot ID from `ocbox snapshot list`',
    }),
    box: Args.string({
      required: false,
      description: 'Session ID; defaults to the selected Session',
    }),
  }
  static override flags = {
    ...snapshotFlags,
    ...mutationFlags,
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SnapshotRestore)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(
        flags,
        'snapshot.restored',
        (result) => `Snapshot ${args['snapshot-id']} restored (operation ${result.operation.id})`,
        async () => {
          const api = createMetadataClient(flags)
          const sessionId = await resolveSnapshotSession(flags, args.box, interrupt.signal)
          const operation = await restoreSnapshotOperation(
            api,
            sessionId,
            args['snapshot-id'],
            idempotencyKey(flags['idempotency-key']),
            interrupt.signal,
          )
          return { operation: await waitForSnapshotOperation(api, operation.id, interrupt.signal) }
        },
      )
    } finally {
      interrupt.dispose()
    }
  }
}

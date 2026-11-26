import { Args } from '@oclif/core'
import { OcboxCommand } from '../../cli/base-command.js'
import { idempotencyKey } from '../../hosted/idempotency.js'
import { createMetadataClient } from '../../metadata/client.js'
import { mutationFlags } from '../../metadata/command.js'
import {
  deleteSnapshotOperation,
  resolveSnapshotSession,
  snapshotFlags,
  waitForSnapshotOperation,
} from './index.js'

export default class SnapshotDelete extends OcboxCommand {
  static override description = 'Delete one of a Session snapshots and wait for it'
  static override args = {
    'snapshot-id': Args.string({
      required: true,
      description: 'Snapshot ID from `ocbox snapshot list`',
    }),
    box: Args.string({
      required: false,
      description: 'Session ID or hosted ses_ ID; defaults to the selected Session',
    }),
  }
  static override flags = {
    ...snapshotFlags,
    ...mutationFlags,
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SnapshotDelete)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(
        flags,
        'snapshot.deleted',
        (result) => `Snapshot ${args['snapshot-id']} deleted (operation ${result.operation.id})`,
        async () => {
          const api = createMetadataClient(flags)
          const sessionId = await resolveSnapshotSession(flags, args.box, interrupt.signal)
          const operation = await deleteSnapshotOperation(
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

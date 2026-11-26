import { Args, Flags } from '@oclif/core'
import { OcboxCommand } from '../../cli/base-command.js'
import { idempotencyKey } from '../../hosted/idempotency.js'
import { createMetadataClient } from '../../metadata/client.js'
import { mutationFlags } from '../../metadata/command.js'
import {
  createSnapshotOperation,
  resolveSnapshotSession,
  snapshotFlags,
  waitForSnapshotOperation,
} from './index.js'

export default class SnapshotSave extends OcboxCommand {
  static override description = 'Take a snapshot of a Session and wait for it'
  static override args = {
    box: Args.string({
      required: false,
      description: 'Session ID or hosted ses_ ID; defaults to the selected Session',
    }),
  }
  static override flags = {
    ...snapshotFlags,
    ...mutationFlags,
    'no-wait': Flags.boolean({
      description: 'Print the operation ID and return without waiting',
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SnapshotSave)
    const interrupt = this.abortOnInterrupt()
    try {
      const name = flags['no-wait'] === true ? 'snapshot.accepted' : 'snapshot.saved'
      await this.emitResult(
        flags,
        name,
        (result) =>
          flags['no-wait'] === true
            ? `Snapshot creation accepted (operation ${result.operation.id})`
            : `Snapshot saved (operation ${result.operation.id})`,
        async () => {
          const api = createMetadataClient(flags)
          const sessionId = await resolveSnapshotSession(flags, args.box, interrupt.signal)
          const operation = await createSnapshotOperation(
            api,
            sessionId,
            idempotencyKey(flags['idempotency-key']),
            interrupt.signal,
          )
          if (flags['no-wait'] === true) return { operation }
          return { operation: await waitForSnapshotOperation(api, operation.id, interrupt.signal) }
        },
      )
    } finally {
      interrupt.dispose()
    }
  }
}

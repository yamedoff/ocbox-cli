import { Args } from '@oclif/core'
import { OcboxCommand } from '../../cli/base-command.js'
import { createMetadataClient } from '../../metadata/client.js'
import { listSnapshots, resolveSnapshotSession, snapshotFlags, snapshotListLine } from './index.js'

export default class SnapshotList extends OcboxCommand {
  static override description = 'List the snapshots a Session keeps, newest first'
  static override args = {
    box: Args.string({
      required: false,
      description: 'Session ID; defaults to the selected Session',
    }),
  }
  static override flags = snapshotFlags

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SnapshotList)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(
        flags,
        'snapshot.listed',
        (result) => snapshotListLine(result.snapshots),
        async () => {
          const api = createMetadataClient(flags)
          const sessionId = await resolveSnapshotSession(flags, args.box, interrupt.signal)
          return listSnapshots(api, sessionId, interrupt.signal)
        },
      )
    } finally {
      interrupt.dispose()
    }
  }
}

import { Flags } from '@oclif/core'
import { OcboxCommand } from '../../cli/base-command.js'
import { listUsage, usageLine } from '../../hosted/billing.js'
import { createMetadataClient } from '../../metadata/client.js'
import { hostedFlags, paginationFlags } from '../../metadata/command.js'

/** One page of hosted billing usage events. */
export default class UsageList extends OcboxCommand {
  static override description = 'List hosted billing usage events'
  static override flags = {
    ...hostedFlags,
    ...paginationFlags,
    'session-id': Flags.string({ description: 'Only usage attributed to this Session ID' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(UsageList)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(
        flags,
        'usage.listed',
        (result) => {
          if (result.usage.length === 0) return 'No usage events'
          const lines = result.usage.map(usageLine)
          if (result.nextCursor !== null) {
            lines.push(`More: ocbox usage list --cursor ${result.nextCursor}`)
          }
          return lines.join('\n')
        },
        () =>
          listUsage(
            createMetadataClient(flags),
            {
              ...(flags['session-id'] === undefined ? {} : { sessionId: flags['session-id'] }),
              ...(flags.cursor === undefined ? {} : { cursor: flags.cursor }),
              ...(flags.limit === undefined ? {} : { limit: flags.limit }),
            },
            interrupt.signal,
          ),
      )
    } finally {
      interrupt.dispose()
    }
  }
}

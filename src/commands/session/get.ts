import { Args } from '@oclif/core'
import { OcboxCommand } from '../../cli/base-command.js'
import { getSession, sessionLine } from '../../hosted/session.js'
import { createMetadataClient } from '../../metadata/client.js'
import { hostedFlags } from '../../metadata/command.js'

/** Read one hosted Session by ID; no local state is read. */
export default class SessionGet extends OcboxCommand {
  static override description = 'Read one hosted Session, including one created over MCP'
  static override args = {
    'session-id': Args.string({
      required: true,
      description: 'Hosted Session ID returned by `ocbox session list` or the MCP session tools',
    }),
  }
  static override flags = hostedFlags

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SessionGet)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(
        flags,
        'session.inspected',
        (result) => sessionLine(result.session),
        () => getSession(createMetadataClient(flags), args['session-id'], interrupt.signal),
      )
    } finally {
      interrupt.dispose()
    }
  }
}

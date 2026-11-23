import { Flags } from '@oclif/core'
import { OcboxCommand } from '../../cli/base-command.js'
import { listSessions, sessionLine } from '../../hosted/session.js'
import { createMetadataClient } from '../../metadata/client.js'
import { hostedFlags, paginationFlags, projectFlag } from '../../metadata/command.js'

/** One page of hosted Sessions in a project; no local state is read. */
export default class SessionList extends OcboxCommand {
  static override description = 'List hosted Sessions in a project'
  static override flags = {
    ...hostedFlags,
    ...projectFlag,
    ...paginationFlags,
    'include-destroyed': Flags.boolean({
      description: 'Include destroyed Sessions (default false)',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(SessionList)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(
        flags,
        'session.listed',
        (result) => {
          const lines =
            result.sessions.length === 0 ? ['No Sessions'] : result.sessions.map(sessionLine)
          if (result.nextCursor !== null) {
            const destroyed = flags['include-destroyed'] ? ' --include-destroyed' : ''
            const limit = flags.limit === undefined ? '' : ` --limit ${flags.limit}`
            lines.push(
              `More: ocbox session list --project-id ${flags['project-id']}${destroyed}${limit} --cursor ${result.nextCursor}`,
            )
          }
          return lines.join('\n')
        },
        () =>
          listSessions(
            createMetadataClient(flags),
            {
              projectId: flags['project-id'],
              ...(flags.cursor === undefined ? {} : { cursor: flags.cursor }),
              ...(flags.limit === undefined ? {} : { limit: flags.limit }),
              ...(flags['include-destroyed'] ? { includeDestroyed: true } : {}),
            },
            interrupt.signal,
          ),
      )
    } finally {
      interrupt.dispose()
    }
  }
}

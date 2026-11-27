import { Flags } from '@oclif/core'
import type { OcboxApiClient } from '../../api/client/index.js'
import { OcboxCommand } from '../../cli/base-command.js'
import { parseHostedResponse } from '../../hosted/response.js'
import {
  HostedSessionPageSchema,
  listSessions,
  sessionLine,
  type HostedSession,
} from '../../hosted/session.js'
import { createMetadataClient } from '../../metadata/client.js'
import { hostedFlags, paginationFlags } from '../../metadata/command.js'

interface SessionListQuery {
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
  readonly includeDestroyed?: boolean | undefined
}

/** One page of hosted Sessions for the owner or one project; no local state is read. */
export default class SessionList extends OcboxCommand {
  static override description =
    'List hosted Sessions in a project, or every Session the account owns'
  static override flags = {
    ...hostedFlags,
    'project-id': Flags.string({
      description:
        'Hosted project ID returned by project create/list; omit to list every Session the account owns',
    }),
    ...paginationFlags,
    'include-destroyed': Flags.boolean({
      description: 'Include destroyed Sessions (default false)',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(SessionList)
    const interrupt = this.abortOnInterrupt()
    try {
      const query: SessionListQuery = {
        ...(flags.cursor === undefined ? {} : { cursor: flags.cursor }),
        ...(flags.limit === undefined ? {} : { limit: flags.limit }),
        ...(flags['include-destroyed'] ? { includeDestroyed: true } : {}),
      }
      await this.emitResult(
        flags,
        'session.listed',
        (result) => {
          const lines =
            result.sessions.length === 0 ? ['No Sessions'] : result.sessions.map(sessionLine)
          if (result.nextCursor !== null) {
            const project =
              flags['project-id'] === undefined ? '' : ` --project-id ${flags['project-id']}`
            const destroyed = flags['include-destroyed'] ? ' --include-destroyed' : ''
            const limit = flags.limit === undefined ? '' : ` --limit ${flags.limit}`
            lines.push(
              `More: ocbox session list${project}${destroyed}${limit} --cursor ${result.nextCursor}`,
            )
          }
          return lines.join('\n')
        },
        () => {
          const api = createMetadataClient(flags)
          return flags['project-id'] === undefined
            ? listOwnerSessions(api, query, interrupt.signal)
            : listSessions(api, { projectId: flags['project-id'], ...query }, interrupt.signal)
        },
      )
    } finally {
      interrupt.dispose()
    }
  }
}

/** One owner-wide page of hosted Sessions, across every project. */
async function listOwnerSessions(
  api: OcboxApiClient,
  input: SessionListQuery,
  signal?: AbortSignal,
): Promise<{ readonly sessions: readonly HostedSession[]; readonly nextCursor: string | null }> {
  const response = await api.generated.listOwnerSessions({
    query: {
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.includeDestroyed === undefined
        ? {}
        : { includeDestroyed: String(input.includeDestroyed) }),
    },
    ...(signal === undefined ? {} : { signal }),
  })
  const { resource } = parseHostedResponse(
    api,
    'session.list',
    response,
    [200],
    HostedSessionPageSchema,
    'session list',
  )
  return { sessions: resource.data, nextCursor: resource.nextCursor }
}

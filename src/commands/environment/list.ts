import {
  metadataFlags,
  MetadataCommand,
  projectFlag,
  paginationFlags,
} from '../../metadata/command.js'

/** Hosted environment list; uses protected login credentials. */
export default class EnvironmentList extends MetadataCommand {
  static override description = 'List hosted environment metadata'
  static override flags = {
    ...metadataFlags,
    ...projectFlag,
    ...paginationFlags,
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvironmentList)
    await this.executeMetadata('environment.list', flags, {
      projectId: flags['project-id'],
      cursor: flags.cursor,
      limit: flags.limit,
    })
  }
}

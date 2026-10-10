import { metadataFlags, MetadataCommand, paginationFlags } from '../../metadata/command.js'

/** Hosted project list; uses protected login credentials. */
export default class ProjectList extends MetadataCommand {
  static override description = 'List hosted project metadata'
  static override flags = {
    ...metadataFlags,
    ...paginationFlags,
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(ProjectList)
    await this.executeMetadata('project.list', flags, {
      cursor: flags.cursor,
      limit: flags.limit,
    })
  }
}

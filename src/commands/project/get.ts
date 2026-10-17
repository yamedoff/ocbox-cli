import { metadataFlags, MetadataCommand, projectFlag } from '../../metadata/command.js'

/** Hosted project get; uses protected login credentials. */
export default class ProjectGet extends MetadataCommand {
  static override description = 'Get hosted project metadata'
  static override flags = {
    ...metadataFlags,
    ...projectFlag,
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(ProjectGet)
    await this.executeMetadata('project.get', flags, {
      projectId: flags['project-id'],
    })
  }
}

import {
  metadataFlags,
  MetadataCommand,
  projectFlag,
  mutationFlags,
  nameFlag,
} from '../../metadata/command.js'

/** Hosted project update; uses protected login credentials. */
export default class ProjectUpdate extends MetadataCommand {
  static override description = 'Update hosted project metadata'
  static override flags = {
    ...metadataFlags,
    ...projectFlag,
    ...mutationFlags,
    ...nameFlag,
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(ProjectUpdate)
    await this.executeMetadata('project.update', flags, {
      projectId: flags['project-id'],
      idempotencyKey: flags['idempotency-key'],
      name: flags.name,
    })
  }
}

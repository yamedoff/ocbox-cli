import { metadataFlags, MetadataCommand, mutationFlags, nameFlag } from '../../metadata/command.js'

/** Hosted project create; uses protected login credentials. */
export default class ProjectCreate extends MetadataCommand {
  static override description = 'Create hosted project metadata'
  static override flags = {
    ...metadataFlags,
    ...mutationFlags,
    ...nameFlag,
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(ProjectCreate)
    await this.executeMetadata('project.create', flags, {
      idempotencyKey: flags['idempotency-key'],
      name: flags.name,
    })
  }
}

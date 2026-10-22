import {
  metadataFlags,
  MetadataCommand,
  projectFlag,
  mutationFlags,
  nameFlag,
} from '../../metadata/command.js'

/** Hosted environment create; uses protected login credentials. */
export default class EnvironmentCreate extends MetadataCommand {
  static override description = 'Create hosted environment metadata'
  static override flags = {
    ...metadataFlags,
    ...projectFlag,
    ...mutationFlags,
    ...nameFlag,
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvironmentCreate)
    await this.executeMetadata('environment.create', flags, {
      projectId: flags['project-id'],
      idempotencyKey: flags['idempotency-key'],
      name: flags.name,
    })
  }
}

import { metadataFlags, MetadataCommand, environmentFlag } from '../../metadata/command.js'

/** Hosted environment get; uses protected login credentials. */
export default class EnvironmentGet extends MetadataCommand {
  static override description = 'Get hosted environment metadata'
  static override flags = {
    ...metadataFlags,
    ...environmentFlag,
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvironmentGet)
    await this.executeMetadata('environment.get', flags, {
      environmentId: flags['environment-id'],
    })
  }
}

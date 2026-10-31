import { Flags } from '@oclif/core'
import {
  metadataFlags,
  MetadataCommand,
  environmentFlag,
  mutationFlags,
} from '../../metadata/command.js'

/** Hosted environment update; uses protected login credentials. */
export default class EnvironmentUpdate extends MetadataCommand {
  static override description = 'Update hosted environment metadata'
  static override flags = {
    ...metadataFlags,
    ...environmentFlag,
    ...mutationFlags,
    name: Flags.string({ description: 'Resource name (1–200 characters)' }),
    selected: Flags.string({
      options: ['true', 'false'],
      description: 'Set selected state explicitly',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvironmentUpdate)
    await this.executeMetadata('environment.update', flags, {
      environmentId: flags['environment-id'],
      idempotencyKey: flags['idempotency-key'],
      name: flags.name,
      selected: flags.selected === undefined ? undefined : flags.selected === 'true',
    })
  }
}

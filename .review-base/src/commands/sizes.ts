import { OcboxCommand } from '../cli/base-command.js'
import { metadataFlags } from '../metadata/command.js'
import { createMetadataClient } from '../metadata/client.js'
import { listSizes, sizeLine } from '../metadata/sizes.js'

/** Hosted size list; uses protected login credentials. */
export default class Sizes extends OcboxCommand {
  static override description =
    'List the box sizes your plan allows; pick one with `ocbox start --size <id>`'
  static override flags = metadataFlags

  async run(): Promise<void> {
    const { flags } = await this.parse(Sizes)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(
        flags,
        'sizes.listed',
        (result) =>
          result.sizes.length === 0
            ? 'No sizes on your plan'
            : result.sizes.map(sizeLine).join('\n'),
        () => listSizes(createMetadataClient(flags), interrupt.signal),
      )
    } finally {
      interrupt.dispose()
    }
  }
}

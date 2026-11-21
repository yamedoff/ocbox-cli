import { Flags } from '@oclif/core'
import { OcboxCommand } from '../../cli/base-command.js'
import { idempotencyKey } from '../../hosted/idempotency.js'
import { createPreview, previewLine } from '../../hosted/preview.js'
import { createMetadataClient } from '../../metadata/client.js'
import { hostedFlags, mutationFlags } from '../../metadata/command.js'

/** Create one hosted preview URL for a session port. */
export default class PreviewCreate extends OcboxCommand {
  static override description = 'Create a preview URL for a port on a hosted Session'
  static override flags = {
    ...hostedFlags,
    ...mutationFlags,
    session: Flags.string({
      required: true,
      description: 'Hosted Session ID',
    }),
    port: Flags.integer({
      required: true,
      min: 1,
      max: 65_535,
      description: 'Port inside the box to expose',
    }),
    'ttl-seconds': Flags.integer({
      min: 60,
      max: 86_400,
      description: 'Preview lifetime in seconds (default 3600)',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(PreviewCreate)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(
        flags,
        'preview.created',
        (result) => previewLine(result.preview),
        () =>
          createPreview(
            createMetadataClient(flags),
            {
              sessionId: flags.session,
              port: flags.port,
              ...(flags['ttl-seconds'] === undefined ? {} : { ttlSeconds: flags['ttl-seconds'] }),
            },
            idempotencyKey(flags['idempotency-key']),
            interrupt.signal,
          ),
      )
    } finally {
      interrupt.dispose()
    }
  }
}

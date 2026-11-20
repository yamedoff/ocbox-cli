import { OcboxCommand } from '../../cli/base-command.js'
import { getWallet, walletLine } from '../../hosted/billing.js'
import { createMetadataClient } from '../../metadata/client.js'
import { hostedFlags } from '../../metadata/command.js'

/** The derived hosted billing wallet. */
export default class WalletGet extends OcboxCommand {
  static override description = 'Show the derived hosted billing wallet'
  static override flags = hostedFlags

  async run(): Promise<void> {
    const { flags } = await this.parse(WalletGet)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(
        flags,
        'wallet.inspected',
        (result) => walletLine(result.wallet),
        () => getWallet(createMetadataClient(flags), interrupt.signal),
      )
    } finally {
      interrupt.dispose()
    }
  }
}

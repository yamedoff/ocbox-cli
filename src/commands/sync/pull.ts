import { Flags } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'
import {
  confirmSyncDeletion,
  isInteractiveForFlags,
  resolveSyncContext,
  syncCliRules,
} from '../../sync/command.js'
import { renderSyncApplied, runSyncApply } from '../../sync/service.js'

/** One-way remote-to-local apply; deletions require `--delete` and confirmation. */
export default class SyncPull extends OcboxCommand {
  static override description = 'Apply Session-workspace-only changes to the local workspace'
  static override flags = {
    ...runtimeFlags,
    session: Flags.string({ description: 'Session ID; defaults to the selected Session' }),
    'local-dir': Flags.string({
      description: 'Local target root; defaults to the current directory',
    }),
    'remote-dir': Flags.string({
      description: 'Provider/fake workspace root; defaults under the state directory',
    }),
    exclude: Flags.string({ multiple: true, description: 'Repeatable exclude pattern' }),
    include: Flags.string({ multiple: true, description: 'Repeatable re-include pattern' }),
    delete: Flags.boolean({ description: 'Approve deleting local entries' }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Acknowledge destructive deletions noninteractively',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(SyncPull)
    await this.emitResult(flags, 'sync.pulled', renderSyncApplied, async () => {
      const context = await resolveSyncContext(flags)
      return runSyncApply(context, 'pull', {
        cliRules: syncCliRules(flags),
        delete: flags.delete === true,
        yes: flags.yes === true,
        interactive: isInteractiveForFlags(flags),
        confirm: confirmSyncDeletion,
      })
    })
  }
}

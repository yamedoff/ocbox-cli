import { Flags } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'
import { resolveSyncContext, syncCliRules } from '../../sync/command.js'
import { renderSyncPlan, runSyncDiff } from '../../sync/service.js'

/** Read-only three-way comparison; never mutates either side. */
export default class SyncDiff extends OcboxCommand {
  static override description =
    'Compare the local workspace, the Session workspace, and the last verified baseline'
  static override flags = {
    ...runtimeFlags,
    session: Flags.string({ description: 'Session ID; defaults to the selected Session' }),
    'local-dir': Flags.string({
      description: 'Local source root; defaults to the current directory',
    }),
    'remote-dir': Flags.string({
      description: 'Provider/fake workspace root; defaults under the state directory',
    }),
    exclude: Flags.string({ multiple: true, description: 'Repeatable exclude pattern' }),
    include: Flags.string({ multiple: true, description: 'Repeatable re-include pattern' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(SyncDiff)
    await this.emitResult(flags, 'sync.diff', renderSyncPlan, async () => {
      const context = await resolveSyncContext(flags)
      return runSyncDiff(context, { cliRules: syncCliRules(flags) })
    })
  }
}

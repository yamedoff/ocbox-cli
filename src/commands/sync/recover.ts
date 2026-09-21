import { Flags } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'
import { resolveSyncContext } from '../../sync/command.js'
import { renderSyncRecover, runSyncRecover } from '../../sync/service.js'

/** Resolves an interrupted transfer; staged content is never silently promoted. */
export default class SyncRecover extends OcboxCommand {
  static override description = 'Resolve a previous interrupted sync that requires recovery'
  static override flags = {
    ...runtimeFlags,
    session: Flags.string({ description: 'Session ID; defaults to the selected Session' }),
    'local-dir': Flags.string({
      description: 'Local target root; defaults to the current directory',
    }),
    'remote-dir': Flags.string({
      description: 'Provider/fake workspace root; defaults under the state directory',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(SyncRecover)
    await this.emitResult(flags, 'sync.recovered', renderSyncRecover, async () => {
      const context = await resolveSyncContext(flags)
      return runSyncRecover(context)
    })
  }
}

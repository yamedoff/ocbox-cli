import { Args } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { createLifecycleService } from '../cli/runtime.js'
import { sessionViewLine } from '../cli/views.js'

export default class Use extends OcboxCommand {
  static override args = { session: Args.string({ required: true, description: 'Session ID' }) }
  static override description = 'Select a Session for subsequent commands'
  static override flags = runtimeFlags

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Use)
    await this.emitResult(flags, 'session.selected', sessionViewLine, async () =>
      (await createLifecycleService(flags)).use(args.session),
    )
  }
}

import { Flags } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { createLifecycleService } from '../cli/runtime.js'
import { sessionViewLine } from '../cli/views.js'

export default class Status extends OcboxCommand {
  static override description = 'Inspect a Session and its primary Sandbox binding'
  static override flags = {
    ...runtimeFlags,
    session: Flags.string({ description: 'Session ID; defaults to the selected Session' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Status)
    await this.emitResult(flags, 'session.inspected', sessionViewLine, async () =>
      (await createLifecycleService(flags)).status(flags.session),
    )
  }
}

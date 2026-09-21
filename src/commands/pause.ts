import { Flags } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { createLifecycleService } from '../cli/runtime.js'
import { sessionViewLine } from '../cli/views.js'

export default class Pause extends OcboxCommand {
  static override description = 'Pause a Session while preserving memory and filesystem'
  static override flags = {
    ...runtimeFlags,
    session: Flags.string({ description: 'Session ID; defaults to the selected Session' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Pause)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(flags, 'session.paused', sessionViewLine, async () =>
        (await createLifecycleService(flags, interrupt.signal)).pause(flags.session),
      )
    } finally {
      interrupt.dispose()
    }
  }
}

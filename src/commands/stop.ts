import { Flags } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { createLifecycleService } from '../cli/runtime.js'
import { sessionViewLine } from '../cli/views.js'

export default class Stop extends OcboxCommand {
  static override description = 'Stop a Session while preserving its filesystem'
  static override flags = {
    ...runtimeFlags,
    session: Flags.string({ description: 'Session ID; defaults to the selected Session' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Stop)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(flags, 'session.stopped', sessionViewLine, async () =>
        (await createLifecycleService(flags, interrupt.signal)).stop(flags.session),
      )
    } finally {
      interrupt.dispose()
    }
  }
}

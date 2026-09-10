import { Flags } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { createLifecycleService } from '../cli/runtime.js'
import { sessionViewLine } from '../cli/views.js'

export default class Start extends OcboxCommand {
  static override description = 'Create, resume, start, or reconcile the selected Session'
  static override flags = {
    ...runtimeFlags,
    new: Flags.boolean({ description: 'Always create and select a new Session' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Start)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(flags, 'session.started', sessionViewLine, async () => {
        const service = await createLifecycleService(flags, interrupt.signal)
        return service.start(flags.new)
      })
    } finally {
      interrupt.dispose()
    }
  }
}

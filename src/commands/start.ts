import { Flags, ux } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { createLifecycleService, loadProjectConfig } from '../cli/runtime.js'
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
    let spinning = false
    try {
      await this.emitResult(flags, 'session.started', sessionViewLine, async () => {
        if (
          !flags.json &&
          !flags.jsonl &&
          (await loadProjectConfig(flags)).provider.name === 'ocbox'
        ) {
          if (process.stderr.isTTY) {
            ux.action.start('Waiting for hosted sandbox to be ready')
            spinning = true
          } else {
            process.stderr.write('Waiting for hosted sandbox to be ready...\n')
          }
        }
        const service = await createLifecycleService(flags, interrupt.signal)
        return service.start(flags.new)
      })
    } finally {
      if (spinning) ux.action.stop()
      interrupt.dispose()
    }
  }
}

import { Flags, ux } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { createLifecycleService, loadProjectConfig, resolveStateDirectory } from '../cli/runtime.js'
import { sessionViewLine } from '../cli/views.js'
import { hasSyncedSource } from '../sync/status.js'

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
    let nextStep: string | undefined
    try {
      await this.emitResult(
        flags,
        'session.started',
        (view) => {
          const line = sessionViewLine(view)
          const notice =
            view.startedNewAfterDestroy === true
              ? 'The selected box was destroyed; started a new one\n'
              : ''
          return nextStep === undefined ? `${notice}${line}` : `${notice}${line}\nNext: ${nextStep}`
        },
        async () => {
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
          const view = await service.start(flags.new)
          if (
            !(await hasSyncedSource(
              resolveStateDirectory(flags),
              view.session.projectId,
              view.session.id,
            ))
          ) {
            nextStep = 'ocbox sync push'
          }
          return view
        },
      )
    } finally {
      if (spinning) ux.action.stop()
      interrupt.dispose()
    }
  }
}

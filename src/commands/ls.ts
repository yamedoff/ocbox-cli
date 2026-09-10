import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { createLifecycleService } from '../cli/runtime.js'
import { sessionViewLine } from '../cli/views.js'

export default class ListSessions extends OcboxCommand {
  static override description = 'List Sessions and their primary Sandbox bindings'
  static override flags = runtimeFlags

  async run(): Promise<void> {
    const { flags } = await this.parse(ListSessions)
    await this.emitResult(
      flags,
      'sessions.listed',
      (views) => (views.length === 0 ? 'No Sessions' : views.map(sessionViewLine).join('\n')),
      async () => (await createLifecycleService(flags)).list(),
    )
  }
}

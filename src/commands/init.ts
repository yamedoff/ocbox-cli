import { Flags } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { initializeProject } from '../cli/runtime.js'
import { FAKE_PROVIDER_NOTICE } from '../errors/messages.js'

export default class Init extends OcboxCommand {
  static override description = 'Create or validate opencloudbox.toml safely'
  static override flags = {
    ...runtimeFlags,
    provider: Flags.string({
      options: ['fake', 'ocbox'],
      description: 'Provider; defaults to ocbox after login, otherwise fake',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Init)
    let initialized = false
    await this.emitResult(
      flags,
      'project.initialized',
      (result) => `Project configuration ${result}`,
      async () => {
        const result = await initializeProject(flags)
        initialized = true
        return result
      },
    )
    if (initialized && flags.provider === 'fake') {
      process.stderr.write(`${FAKE_PROVIDER_NOTICE}\n`)
    }
  }
}

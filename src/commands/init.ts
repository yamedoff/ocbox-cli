import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { initializeProject } from '../cli/runtime.js'

export default class Init extends OcboxCommand {
  static override description = 'Create or validate opencloudbox.toml safely'
  static override flags = runtimeFlags

  async run(): Promise<void> {
    const { flags } = await this.parse(Init)
    await this.emitResult(
      flags,
      'project.initialized',
      (result) => `Project configuration ${result}`,
      () => initializeProject(flags),
    )
  }
}

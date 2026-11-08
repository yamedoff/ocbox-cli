import { Flags } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { initializeProject, type ProjectInitialization } from '../cli/runtime.js'
import { FAKE_PROVIDER_NOTICE } from '../errors/messages.js'

function initializationMessage(result: ProjectInitialization): string {
  if (result.status === 'validated') return 'Validated opencloudbox.toml'
  if (result.provider !== 'ocbox' || result.projectId === undefined)
    return 'Project configuration created'
  if (result.projectCreated === true) {
    const name = result.projectName === undefined ? '' : ` ("${result.projectName}")`
    return `Created project ${result.projectId}${name} and wrote opencloudbox.toml`
  }
  if (result.projectMatchedByName === true) {
    const name = result.projectName === undefined ? '' : ` ("${result.projectName}")`
    return `Using existing project ${result.projectId}${name}, matched by name; run ocbox project create to make a new one`
  }
  return `Using existing project ${result.projectId}`
}

export default class Init extends OcboxCommand {
  static override description =
    'Create or validate opencloudbox.toml; creates the hosted project when needed'
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
    await this.emitResult(flags, 'project.initialized', initializationMessage, async () => {
      const result = await initializeProject(flags)
      initialized = true
      return result
    })
    if (initialized && flags.provider === 'fake') {
      process.stderr.write(`${FAKE_PROVIDER_NOTICE}\n`)
    }
  }
}

import { Flags } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { initializeProject, type ProjectInitialization } from '../cli/runtime.js'
import { providerNotice } from '../errors/messages.js'

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
    let result: ProjectInitialization | undefined
    await this.emitResult(flags, 'project.initialized', initializationMessage, async () => {
      result = await initializeProject(flags)
      return result
    })
    if (result === undefined) return
    // The notice is human guidance only; structured modes must leave stderr empty.
    if (flags.json === true || flags.jsonl === true) return
    // Provider guidance goes to stderr so it never mixes with the human message.
    // Environment is an index signature; bracket access is required by TypeScript.
    // biome-ignore lint/complexity/useLiteralKeys: see explanation above
    const notice = providerNotice(result.provider, flags['api-url'] ?? process.env['OCBOX_API_URL'])
    if (notice !== undefined) {
      process.stderr.write(`${notice}\n`)
    }
  }
}

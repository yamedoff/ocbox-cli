import { Flags } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { runUpdate, type UpdateResult } from '../release/update.js'

function updateMessage(result: UpdateResult, check: boolean): string {
  if (check) {
    if (result.updateAvailable) {
      return `ocbox ${result.currentVersion} -> ${result.latestVersion}; run: ocbox update`
    }
    if (result.latestVersion === result.currentVersion) {
      return `ocbox ${result.currentVersion} is up to date`
    }
    return `ocbox ${result.currentVersion} is newer than the latest release ${result.latestVersion}`
  }
  if (!result.updated) return `ocbox ${result.currentVersion} is already up to date`
  return `Updated ocbox ${result.currentVersion} -> ${result.latestVersion}`
}

export default class Update extends OcboxCommand {
  static override description = 'Install the latest ocbox release'
  static override flags = {
    ...runtimeFlags,
    check: Flags.boolean({ description: 'Report the latest release without installing it' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Update)
    const check = flags.check === true
    await this.emitResult(
      flags,
      check ? 'update.checked' : 'update.installed',
      (result: UpdateResult) => updateMessage(result, check),
      () => runUpdate({ check }),
    )
  }
}

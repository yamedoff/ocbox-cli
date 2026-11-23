import { Flags } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { OcboxError } from '../errors/index.js'
import { ReleaseNotPublishedError } from '../release/release.js'
import { runUpdate, type UpdateResult } from '../release/update.js'

const NO_RELEASE_GUIDANCE =
  'No ocbox release is published yet; install from npm instead: npm i -g opencloudbox'

/** An empty release channel is a dead end unless the command names the way out. */
function updateFailure(error: unknown): unknown {
  if (!(error instanceof ReleaseNotPublishedError)) return error
  return new OcboxError({
    code: error.code,
    message: NO_RELEASE_GUIDANCE,
    requestId: error.requestId,
  })
}

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
      async () => {
        try {
          return await runUpdate({ check })
        } catch (error) {
          throw updateFailure(error)
        }
      },
    )
  }
}

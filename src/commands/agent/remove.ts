import { rm } from 'node:fs/promises'
import { Args, Flags } from '@oclif/core'
import {
  manifestFile,
  planCodexRemove,
  readManifestSafe,
  readTextOrNull,
  writeFileAtomic,
} from '../../agents/codex/index.js'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'
import { resolveStateDirectory } from '../../cli/runtime.js'

export default class AgentRemove extends OcboxCommand {
  static override description =
    'Remove only the owned Codex adapter fragments, preserving user edits'
  static override args = {
    adapter: Args.string({
      required: true,
      description: 'Adapter name (only "codex" is supported)',
    }),
  }
  static override flags = {
    ...runtimeFlags,
    'codex-home': Flags.string({ description: 'Override CODEX_HOME for Codex discovery' }),
    'project-dir': Flags.string({ description: 'Project directory for the project layer' }),
    yes: Flags.boolean({ description: 'Apply the removal; without it only the plan is printed' }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentRemove)
    if (args['adapter'] !== 'codex') {
      throw new Error(`Unknown agent adapter "${args['adapter']}"; only "codex" is supported.`)
    }
    await this.emitResult(
      flags,
      'agent.codex.remove',
      (result: unknown) => JSON.stringify(result),
      async () => {
        const stateDirectory = resolveStateDirectory(flags)
        const { manifest, warning } = await readManifestSafe(manifestFile(stateDirectory))
        if (manifest === null) {
          return {
            ok: true,
            applied: false,
            actions: [],
            repairSteps: [],
            warnings:
              warning === null ? ['No adapter manifest; nothing owned to remove.'] : [warning],
          }
        }
        const currentTomlText = await readTextOrNull(manifest.configFile)
        const currentHooksText = await readTextOrNull(manifest.hooksFile)
        const originalTomlText =
          manifest.backupConfigPath === null
            ? null
            : await readTextOrNull(manifest.backupConfigPath)
        const originalHooksText =
          manifest.backupHooksPath === null ? null : await readTextOrNull(manifest.backupHooksPath)
        const plan = planCodexRemove({
          manifest,
          currentTomlText,
          currentHooksText,
          originalTomlText,
          originalHooksText,
        })
        const warnings = warning === null ? [...plan.warnings] : [warning, ...plan.warnings]
        if (flags['yes'] !== true) {
          return {
            ok: true,
            applied: false,
            actions: plan.actions.map((action) => ({
              file: action.file,
              action: action.action,
              detail: action.detail,
            })),
            repairSteps: [...plan.repairSteps],
            warnings,
          }
        }
        for (const action of plan.actions) {
          if (action.action === 'noop') continue
          if (action.preservedCopy !== null && action.preservedCopy.length > 0) {
            const current = action.file === manifest.configFile ? currentTomlText : currentHooksText
            if (current !== null) await writeFileAtomic(action.preservedCopy, current)
          }
          if (action.action === 'delete') {
            await rm(action.file, { force: true })
          } else if (action.after !== null) {
            await writeFileAtomic(action.file, action.after)
          }
        }
        await rm(manifestFile(stateDirectory), { force: true })
        return {
          ok: true,
          applied: true,
          actions: plan.actions.map((action) => ({
            file: action.file,
            action: action.action,
            detail: action.detail,
          })),
          repairSteps: [...plan.repairSteps],
          warnings,
        }
      },
    )
  }
}

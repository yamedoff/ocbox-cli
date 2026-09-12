import { rm } from 'node:fs/promises'
import { Args, Flags } from '@oclif/core'
import {
  manifestFile,
  manifestPathForLayer,
  nodeCodexFileSystem,
  planCodexRemove,
  readManifestSafe,
  readTextOrNull,
  type CodexLayer,
  type CodexManifest,
} from '../../agents/codex/index.js'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'
import { resolveStateDirectory } from '../../cli/runtime.js'

const LAYERS: readonly CodexLayer[] = ['user', 'project']

async function removeLayer(
  stateDirectory: string,
  layer: CodexLayer,
  apply: boolean,
): Promise<{
  readonly manifest: CodexManifest | null
  readonly result: Record<string, unknown>
}> {
  const { manifest, warning } = await readManifestSafe(manifestPathForLayer(stateDirectory, layer))
  if (manifest === null) {
    const legacy = layer === 'user' ? await readTextOrNull(manifestFile(stateDirectory)) : null
    const warnings =
      warning === null
        ? legacy !== null
          ? [
              'A legacy single-layer manifest exists; it is ignored by this adapter version. Nothing owned to remove.',
            ]
          : ['No adapter manifest; nothing owned to remove.']
        : [warning]
    return {
      manifest,
      result: { ok: true, applied: false, actions: [], repairSteps: [], warnings },
    }
  }
  const currentTomlText = await readTextOrNull(manifest.configPath)
  const currentHooksText = await readTextOrNull(manifest.hooksPath)
  const originalTomlText =
    manifest.backupConfigPath == null ? null : await readTextOrNull(manifest.backupConfigPath)
  const originalHooksText =
    manifest.backupHooksPath == null ? null : await readTextOrNull(manifest.backupHooksPath)
  const plan = planCodexRemove({
    manifest,
    currentTomlText,
    currentHooksText,
    originalTomlText,
    originalHooksText,
  })
  const warnings = warning === null ? [...plan.warnings] : [warning, ...plan.warnings]
  if (plan.status === 'repair-required') {
    return {
      manifest,
      result: {
        ok: true,
        applied: false,
        actions: [],
        repairSteps: [...plan.repairSteps],
        warnings,
        repairs: plan.repairs.map((repair) => ({
          reason: repair.reason,
          id: repair.id,
          event: repair.event,
        })),
      },
    }
  }
  if (apply) {
    for (const action of plan.actions) {
      if (action.action === 'noop') continue
      if (action.preservedCopy !== null && action.preservedCopy.length > 0) {
        const current = action.file === manifest.configPath ? currentTomlText : currentHooksText
        if (current !== null) {
          await nodeCodexFileSystem.writeFileAtomic(action.preservedCopy, current)
        }
      }
      if (action.action === 'delete') {
        await rm(action.file, { force: true })
      } else if (action.after !== null) {
        await nodeCodexFileSystem.writeFileAtomic(action.file, action.after)
      }
    }
    await rm(manifestPathForLayer(stateDirectory, layer), { force: true })
  }
  return {
    manifest,
    result: {
      ok: true,
      applied: apply,
      actions: plan.actions.map((action) => ({
        file: action.file,
        action: action.action,
        detail: action.detail,
      })),
      repairSteps: [...plan.repairSteps],
      warnings,
    },
  }
}

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
    layer: Flags.string({
      description: 'Config layer to remove: user, project, or all (default all)',
    }),
    'codex-home': Flags.string({ description: 'Override CODEX_HOME for Codex discovery' }),
    'project-dir': Flags.string({ description: 'Project directory for the project layer' }),
    yes: Flags.boolean({ description: 'Apply the removal; without it only the plan is printed' }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentRemove)
    if (args['adapter'] !== 'codex') {
      throw new Error(`Unknown agent adapter "${args['adapter']}"; only "codex" is supported.`)
    }
    const rawLayer = flags['layer']
    const layers: readonly CodexLayer[] =
      rawLayer === undefined || rawLayer === 'all'
        ? LAYERS
        : rawLayer === 'user' || rawLayer === 'project'
          ? [rawLayer]
          : (() => {
              throw new Error(`Unknown layer "${rawLayer}"; use user, project, or all.`)
            })()
    await this.emitResult(
      flags,
      'agent.codex.remove',
      (result: unknown) => JSON.stringify(result),
      async () => {
        const stateDirectory = resolveStateDirectory(flags)
        const apply = flags['yes'] === true
        const actions: unknown[] = []
        const repairSteps: string[] = []
        const warnings: string[] = []
        const repairs: unknown[] = []
        let applied = false
        for (const layer of layers) {
          const { result } = await removeLayer(stateDirectory, layer, apply)
          actions.push(...((result['actions'] as unknown[]) ?? []))
          repairSteps.push(...((result['repairSteps'] as string[]) ?? []))
          warnings.push(...((result['warnings'] as string[]) ?? []))
          if ((result['applied'] as boolean) === true) applied = true
          if ((result['repairs'] as unknown) !== undefined) {
            repairs.push(...((result['repairs'] as unknown[]) ?? []))
          }
        }
        return repairs.length > 0
          ? { ok: true, applied: false, actions, repairSteps, warnings, repairs }
          : { ok: true, applied, actions, repairSteps, warnings }
      },
    )
  }
}

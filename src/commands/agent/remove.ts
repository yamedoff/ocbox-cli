import { Args, Flags } from '@oclif/core'
import {
  applyCodexRemovePlan,
  layerTargetFiles,
  manifestFile,
  manifestPathForLayer,
  nodeCodexFileSystem,
  parseLegacyCodexManifest,
  planCodexRemove,
  readManifestSafe,
  readTextOrNull,
  resolveAgentCodexPaths,
  type CodexLayer,
  type CodexManifest,
  type LegacyCodexManifest,
} from '../../agents/codex/index.js'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'
import { resolveStateDirectory } from '../../cli/runtime.js'

const LAYERS: readonly CodexLayer[] = ['user', 'project']

interface RemoveLayerOptions {
  readonly stateDirectory: string
  readonly layer: CodexLayer
  readonly apply: boolean
  readonly codexHome?: string | undefined
  readonly projectDir?: string | undefined
}

async function removeLayer(options: RemoveLayerOptions): Promise<{
  readonly manifest: CodexManifest | null
  readonly result: Record<string, unknown>
}> {
  const { stateDirectory, layer, apply } = options
  const paths = resolveAgentCodexPaths({
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
    ...(options.projectDir === undefined ? {} : { projectDir: options.projectDir }),
    stateDirectory,
  })
  const targets = layerTargetFiles(paths, layer)
  const manifestPath = manifestPathForLayer(stateDirectory, layer)
  const { manifest, warning } = await readManifestSafe(manifestPath)
  const legacyText = await readTextOrNull(manifestFile(stateDirectory))
  const legacyManifest: LegacyCodexManifest | null =
    legacyText === null ? null : parseLegacyCodexManifest(legacyText)
  const configFile = manifest?.configPath ?? targets.configFile
  const hooksFile = manifest?.hooksPath ?? targets.hooksFile
  const currentTomlText = await readTextOrNull(configFile)
  const currentHooksText = await readTextOrNull(hooksFile)
  const originalTomlText =
    manifest?.backupConfigPath == null ? null : await readTextOrNull(manifest.backupConfigPath)
  const originalHooksText =
    manifest?.backupHooksPath == null ? null : await readTextOrNull(manifest.backupHooksPath)
  const plan = planCodexRemove({
    manifest,
    legacyManifest,
    layer,
    configFile,
    hooksFile,
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
  if (apply && plan.actions.some((action) => action.action !== 'noop')) {
    await applyCodexRemovePlan(
      { actions: plan.actions, manifestPath: manifest === null ? null : manifestPath },
      nodeCodexFileSystem,
    )
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
          const { result } = await removeLayer({
            stateDirectory,
            layer,
            apply,
            ...(flags['codex-home'] === undefined ? {} : { codexHome: flags['codex-home'] }),
            ...(flags['project-dir'] === undefined ? {} : { projectDir: flags['project-dir'] }),
          })
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

import { Args, Flags } from '@oclif/core'
import { readInstalledClaudeVersion } from '../../agents/claude-code/claude-executable.js'
import { liveFileAccess, planRemove as planClaudeRemove } from '../../agents/claude-code/planner.js'
import { resolveClaudeSettingsLayout as resolveClaudeLayout } from '../../agents/claude-code/settings-sources.js'
import {
  assertClaudeVersionOverrideAllowed,
  PINNED_CLAUDE_CODE_VERSION,
  TEST_HARNESS_ENV,
} from '../../agents/claude-code/version.js'
import {
  applyCodexRemovePlan,
  assertAdapterOwnedPath,
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

const CODEX_LAYERS: readonly CodexLayer[] = ['user', 'project']

interface RemoveLayerOptions {
  readonly stateDirectory: string
  readonly layer: CodexLayer
  readonly apply: boolean
  readonly codexHome?: string | undefined
  readonly projectDir?: string | undefined
}

async function removeCodexLayer(options: RemoveLayerOptions): Promise<{
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
    const applyRoot = layer === 'project' ? paths.projectDirectory : paths.codexHome
    if (applyRoot === null) {
      throw new Error('The project layer requires a project directory; pass --project-dir.')
    }
    for (const action of plan.actions) {
      if (action.action === 'noop') continue
      assertAdapterOwnedPath(action.file, applyRoot, paths.platform)
      if (action.preservedCopy !== null) {
        assertAdapterOwnedPath(action.preservedCopy, applyRoot, paths.platform)
      }
    }
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

async function runCodexRemove(flags: Record<string, unknown>): Promise<unknown> {
  const rawLayer = flags['layer'] as string | undefined
  const layers: readonly CodexLayer[] =
    rawLayer === undefined || rawLayer === 'all'
      ? CODEX_LAYERS
      : rawLayer === 'user' || rawLayer === 'project'
        ? [rawLayer]
        : (() => {
            throw new Error(`Unknown layer "${rawLayer}"; use user, project, or all.`)
          })()
  const stateDirectory = resolveStateDirectory(flags as never)
  const apply = flags['yes'] === true
  const actions: unknown[] = []
  const repairSteps: string[] = []
  const warnings: string[] = []
  const repairs: unknown[] = []
  let applied = false
  for (const layer of layers) {
    const { result } = await removeCodexLayer({
      stateDirectory,
      layer,
      apply,
      ...(flags['codex-home'] === undefined ? {} : { codexHome: flags['codex-home'] as string }),
      ...(flags['project-dir'] === undefined ? {} : { projectDir: flags['project-dir'] as string }),
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
}

async function runClaudeRemove(flags: Record<string, unknown>): Promise<unknown> {
  const scope = flags['scope'] as 'user' | 'project' | 'local'
  const override = flags['claude-version'] as string | undefined
  assertClaudeVersionOverrideAllowed(override)
  const detected = override ?? (await readInstalledClaudeVersion())
  const layout = resolveClaudeLayout({
    projectDirectory: flags['project-dir'] as string | undefined,
  })
  return planClaudeRemove({
    layout,
    scope,
    sessionId: null,
    claudeVersionRaw: detected,
    files: liveFileAccess(),
  })
}

export default class AgentRemove extends OcboxCommand {
  static override description = 'Remove a coding-agent routing adapter (restores owned changes)'
  static override args = {
    adapter: Args.string({
      required: true,
      description: 'Adapter name ("codex" or "claude-code")',
    }),
  }
  static override flags = {
    ...runtimeFlags,
    layer: Flags.string({
      description: 'Codex config layer to remove: user, project, or all (default all)',
    }),
    scope: Flags.string({
      description: 'Claude-code settings scope owned by the adapter',
      options: ['user', 'project', 'local'],
      default: 'project',
    }),
    'codex-home': Flags.string({ description: 'Override CODEX_HOME for Codex discovery' }),
    'project-dir': Flags.string({ description: 'Project directory for the project layer' }),
    yes: Flags.boolean({
      description: 'Apply the removal (codex only); without it only the plan is printed',
    }),
    'claude-version': Flags.string({
      description: `Override detected version (claude-code offline test harness only, requires ${TEST_HARNESS_ENV}=1; pinned ${PINNED_CLAUDE_CODE_VERSION})`,
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentRemove)
    const adapter = String(args.adapter ?? '')
    if (adapter === 'codex') {
      await this.emitResult(
        flags,
        'agent.codex.remove',
        (result: unknown) => JSON.stringify(result),
        async () => runCodexRemove(flags as unknown as Record<string, unknown>),
      )
      return
    }
    if (adapter === 'claude-code') {
      await this.emitResult(
        flags,
        'agent.remove',
        (result: { status: string; targetPath: string }) =>
          `${result.status}: ${result.targetPath}`,
        async () =>
          runClaudeRemove(flags as unknown as Record<string, unknown>) as Promise<{
            status: string
            targetPath: string
          }>,
      )
      return
    }
    throw new Error(`unknown adapter "${adapter}"; only "codex", "claude-code" are supported`)
  }
}

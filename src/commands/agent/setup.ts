import { Args, Flags } from '@oclif/core'
import { readInstalledClaudeVersion } from '../../agents/claude-code/claude-executable.js'
import { liveFileAccess, planSetup as planClaudeSetup } from '../../agents/claude-code/planner.js'
import { resolveClaudeSettingsLayout as resolveClaudeLayout } from '../../agents/claude-code/settings-sources.js'
import {
  assertClaudeVersionOverrideAllowed,
  PINNED_CLAUDE_CODE_VERSION,
  TEST_HARNESS_ENV,
} from '../../agents/claude-code/version.js'
import {
  applyCodexChangePlan,
  assertAdapterOwnedPathWithinRoot,
  layerTargetFiles,
  manifestPathForLayer,
  manifestFile,
  nodeCodexFileSystem,
  parseLegacyCodexManifest,
  planCodexSetup,
  readManifestSafe,
  readInstalledCodexVersion,
  readTextOrNull,
  resolveAgentCodexPaths,
  resolveCodexExecutable,
  resolveProjectTrustLevel,
  resolveSessionSelection,
  type CodexLayer,
  type LegacyCodexManifest,
} from '../../agents/codex/index.js'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'
import { resolveStateDirectory } from '../../cli/runtime.js'
import {
  flagProvidedChecker,
  irrelevantFlagWarnings,
  warnIrrelevantFlags,
  type FlagMetadata,
} from './adapter-flags.js'

/** Fail-closed exit for a Codex setup plan the adapter refuses to apply. */
const CODEX_SETUP_BLOCKED_EXIT_CODE = 2

function parseCodexLayer(raw: string | undefined): CodexLayer {
  if (raw === undefined || raw === 'user') return 'user'
  if (raw === 'project') return 'project'
  throw new Error(`Unknown layer "${raw}"; use user or project.`)
}

async function runCodexSetup(
  flags: Record<string, unknown>,
  extraWarnings: readonly string[] = [],
): Promise<unknown> {
  const layer = parseCodexLayer(flags['layer'] as string | undefined)
  const stateDirectory = resolveStateDirectory(flags as never)
  const paths = resolveAgentCodexPaths({
    ...(flags['codex-home'] === undefined ? {} : { codexHome: flags['codex-home'] as string }),
    ...(flags['project-dir'] === undefined ? {} : { projectDir: flags['project-dir'] as string }),
    stateDirectory,
  })
  const targets = layerTargetFiles(paths, layer)
  const codexExecutable = (await resolveCodexExecutable()) ?? 'codex'
  const versionText = await readInstalledCodexVersion({ executable: codexExecutable })
  const baseTomlText = await readTextOrNull(targets.configFile)
  const baseHooksText = await readTextOrNull(targets.hooksFile)
  const projectDirectory = paths.projectDirectory ?? process.cwd()
  let trustLevel: string | null = null
  if (layer === 'project') {
    const userToml = await readTextOrNull(paths.userConfigFile)
    trustLevel = resolveProjectTrustLevel({
      userConfigToml: userToml,
      layerConfigToml: baseTomlText,
      projectDirectory,
    })
  }
  const selection = await resolveSessionSelection(
    stateDirectory,
    projectDirectory,
    flags['session'] as string | undefined,
  )
  const layeredManifestPath = manifestPathForLayer(stateDirectory, layer)
  const { manifest, warning: layeredWarning } = await readManifestSafe(layeredManifestPath)
  let warning = layeredWarning
  let legacyManifest: LegacyCodexManifest | null = null
  const legacyText = await readTextOrNull(manifestFile(stateDirectory))
  if (legacyText !== null) {
    legacyManifest = parseLegacyCodexManifest(legacyText)
    if (legacyManifest !== null && manifest === null && warning === null) {
      warning =
        'A legacy single-layer manifest exists; its recovered fragments are repaired by strict ownership and a per-layer manifest is recorded.'
    }
  }
  const plan = planCodexSetup(
    {
      versionText,
      layer,
      trustLevel,
      sessionId: selection.sessionId,
      sessionRecorded: selection.recorded,
      allowUnverifiedSchema: flags['allow-unverified-schema'] === true,
      paths,
      baseTomlText,
      baseHooksText,
      legacyManifest,
      ...(flags['ocbox-bin'] === undefined ? {} : { ocboxBin: flags['ocbox-bin'] as string }),
    },
    manifest,
  )
  const warnings =
    warning === null
      ? [...plan.warnings, ...extraWarnings]
      : [warning, ...plan.warnings, ...extraWarnings]
  if (!plan.ok) {
    if (flags['yes'] === true) throw new Error(plan.errors.join(' '))
    // Plan mode still emits the machine-readable plan on stdout, but a
    // fail-closed blocker must not exit 0: without --yes nothing was applied
    // and the caller asked for a setup that cannot proceed.
    process.exitCode = CODEX_SETUP_BLOCKED_EXIT_CODE
    return {
      ok: false,
      applied: false,
      alreadyApplied: false,
      codexExecutable,
      layer: plan.layer,
      configFile: plan.configFile,
      hooksFile: plan.hooksFile,
      errors: plan.errors,
      warnings,
      changes: [],
      liveBlocker: plan.liveBlocker,
    }
  }
  if (plan.alreadyApplied || plan.changes.length === 0 || flags['yes'] !== true) {
    return {
      ok: true,
      applied: false,
      alreadyApplied: plan.alreadyApplied,
      codexExecutable,
      layer: plan.layer,
      configFile: plan.configFile,
      hooksFile: plan.hooksFile,
      errors: [],
      warnings,
      changes: plan.changes.map((change) => ({
        file: change.file,
        kind: change.kind,
        representation: change.representation,
      })),
      liveBlocker: plan.liveBlocker,
    }
  }
  const applyRoot = plan.layer === 'project' ? paths.projectDirectory : paths.codexHome
  if (applyRoot === null) {
    throw new Error('The project layer requires a project directory; pass --project-dir.')
  }
  for (const change of plan.changes) {
    if (change.kind === 'manifest') continue
    await assertAdapterOwnedPathWithinRoot(change.file, applyRoot, paths.platform)
  }
  await applyCodexChangePlan({ files: plan.changes }, nodeCodexFileSystem)
  const backupConfigPath =
    plan.changes.find((change) => change.kind === 'toml-merge')?.backupPath ?? null
  const backupHooksPath =
    plan.changes.find((change) => change.kind === 'hooks-write')?.backupPath ?? null
  return {
    ok: true,
    applied: true,
    alreadyApplied: false,
    codexExecutable,
    layer: plan.layer,
    configFile: plan.configFile,
    hooksFile: plan.hooksFile,
    errors: [],
    warnings,
    changes: plan.changes.map((change) => ({
      file: change.file,
      kind: change.kind,
      representation: change.representation,
    })),
    backupConfigPath,
    backupHooksPath,
    liveBlocker: plan.liveBlocker,
  }
}

async function runClaudeSetup(flags: Record<string, unknown>): Promise<unknown> {
  const scope = flags['scope'] as 'user' | 'project' | 'local'
  const override = flags['claude-version'] as string | undefined
  assertClaudeVersionOverrideAllowed(override)
  const detected = override ?? (await readInstalledClaudeVersion())
  const layout = resolveClaudeLayout({
    projectDirectory: flags['project-dir'] as string | undefined,
  })
  return planClaudeSetup({
    layout,
    scope,
    sessionId: (flags['session'] as string | undefined) ?? null,
    claudeVersionRaw: detected,
    files: liveFileAccess(),
  })
}

export default class AgentSetup extends OcboxCommand {
  static override description =
    'Set up a coding-agent routing adapter (explicit, idempotent, fail-closed)'
  static override args = {
    adapter: Args.string({
      required: true,
      description: 'Adapter name ("codex" or "claude-code")',
    }),
  }
  static override flags = {
    ...runtimeFlags,
    layer: Flags.string({ description: 'Codex config layer: user or project (default user)' }),
    scope: Flags.string({
      description: 'Claude-code settings scope to own',
      options: ['user', 'project', 'local'],
      default: 'project',
    }),
    session: Flags.string({ description: 'Session ID for remote routing' }),
    'codex-home': Flags.string({ description: 'Override CODEX_HOME for Codex discovery' }),
    'project-dir': Flags.string({ description: 'Project directory for the project layer' }),
    'allow-unverified-schema': Flags.boolean({
      description:
        'Deprecated no-op (codex only): the pinned schema gate now proves the hooks shape',
    }),
    yes: Flags.boolean({
      description: 'Apply the plan (codex only); without it only the plan is printed',
    }),
    'ocbox-bin': Flags.string({ description: 'ocbox binary invoked by the owned codex hook' }),
    'claude-version': Flags.string({
      description: `Override detected version (claude-code offline test harness only, requires ${TEST_HARNESS_ENV}=1; pinned ${PINNED_CLAUDE_CODE_VERSION})`,
    }),
  }

  async run(): Promise<void> {
    const { args, flags, metadata } = await this.parse(AgentSetup)
    const adapter = String(args.adapter ?? '')
    const flagRecord = flags as unknown as Record<string, unknown>
    const isProvided = flagProvidedChecker(flagRecord, metadata as FlagMetadata | undefined)
    if (adapter === 'codex') {
      const flagWarnings = irrelevantFlagWarnings('codex', 'setup', isProvided)
      await this.emitResult(
        flags,
        'agent.codex.setup',
        (result: unknown) => JSON.stringify(result),
        async () => runCodexSetup(flagRecord, flagWarnings),
      )
      return
    }
    if (adapter === 'claude-code') {
      warnIrrelevantFlags('claude-code', 'setup', isProvided)
      await this.emitResult(
        flags,
        'agent.setup',
        (result: { status: string; targetPath: string }) =>
          `${result.status}: ${result.targetPath}`,
        async () =>
          runClaudeSetup(flags as unknown as Record<string, unknown>) as Promise<{
            status: string
            targetPath: string
          }>,
      )
      return
    }
    throw new Error(`unknown adapter "${adapter}"; only "codex", "claude-code" are supported`)
  }
}

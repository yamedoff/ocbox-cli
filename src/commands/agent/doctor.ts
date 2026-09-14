import { Args, Flags } from '@oclif/core'
import { readInstalledClaudeVersion } from '../../agents/claude-code/claude-executable.js'
import { liveFileAccess, planDoctor as planClaudeDoctor } from '../../agents/claude-code/planner.js'
import { resolveClaudeSettingsLayout as resolveClaudeLayout } from '../../agents/claude-code/settings-sources.js'
import {
  assertClaudeVersionOverrideAllowed,
  PINNED_CLAUDE_CODE_VERSION,
  TEST_HARNESS_ENV,
} from '../../agents/claude-code/version.js'
import {
  codexDoctor,
  layerTargetFiles,
  manifestFile,
  manifestPathForLayer,
  parseLegacyCodexManifest,
  readInstalledCodexVersion,
  readManifestSafe,
  readTextOrNull,
  resolveAgentCodexPaths,
  resolveCodexExecutable,
  resolveProjectTrustLevel,
  resolveSessionSelection,
} from '../../agents/codex/index.js'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'
import { resolveStateDirectory } from '../../cli/runtime.js'
import {
  flagProvidedChecker,
  irrelevantFlagWarnings,
  warnIrrelevantFlags,
  type FlagMetadata,
} from './adapter-flags.js'

async function runCodexDoctor(
  flags: Record<string, unknown>,
  extraWarnings: readonly string[] = [],
): Promise<unknown> {
  const rawLayer = flags['layer'] as string | undefined
  const layer = rawLayer === 'project' ? 'project' : 'user'
  if (rawLayer !== undefined && rawLayer !== 'user' && rawLayer !== 'project') {
    throw new Error(`Unknown layer "${rawLayer}"; use user or project.`)
  }
  const stateDirectory = resolveStateDirectory(flags as never)
  const paths = resolveAgentCodexPaths({
    ...(flags['codex-home'] === undefined ? {} : { codexHome: flags['codex-home'] as string }),
    ...(flags['project-dir'] === undefined ? {} : { projectDir: flags['project-dir'] as string }),
    stateDirectory,
  })
  const targets = layerTargetFiles(paths, layer)
  const codexExecutable = (await resolveCodexExecutable()) ?? 'codex'
  const versionText = await readInstalledCodexVersion({ executable: codexExecutable })
  const tomlText = await readTextOrNull(targets.configFile)
  const hooksText = await readTextOrNull(targets.hooksFile)
  const projectDirectory = paths.projectDirectory ?? process.cwd()
  const { manifest, warning } = await readManifestSafe(manifestPathForLayer(stateDirectory, layer))
  let manifestWarning = warning
  let legacyManifest: ReturnType<typeof parseLegacyCodexManifest> = null
  const legacyText = await readTextOrNull(manifestFile(stateDirectory))
  if (legacyText !== null) {
    legacyManifest = parseLegacyCodexManifest(legacyText)
    if (legacyManifest !== null && manifest === null && manifestWarning === null) {
      manifestWarning =
        'A legacy single-layer manifest exists; run setup or remove to repair its owned fragments by strict ownership.'
    }
  }
  const selection = await resolveSessionSelection(
    stateDirectory,
    projectDirectory,
    (flags['session'] as string | undefined) ?? manifest?.sessionId,
  )
  let trustLevel: string | null = null
  if (layer === 'project') {
    const userToml = await readTextOrNull(paths.userConfigFile)
    trustLevel = resolveProjectTrustLevel({
      userConfigToml: userToml,
      layerConfigToml: tomlText,
      projectDirectory,
    })
  }
  const report = codexDoctor({
    versionText,
    tomlText,
    hooksText,
    manifest,
    legacyManifest,
    trustLevel,
    sessionId: selection.sessionId,
    sessionRecorded: selection.recorded,
    environment: process.env,
  })
  const failed = report.checks.filter((check) => check.status === 'fail')
  const checks =
    manifestWarning === null
      ? report.checks
      : [
          {
            id: 'manifest-read',
            status: 'warning' as const,
            summary: manifestWarning,
            remediation: 'Re-run setup to rewrite the manifest.',
          },
          ...report.checks,
        ]
  if (failed.length > 0) {
    throw new Error(
      `Codex doctor found ${failed.length} failing check(s): ${failed.map((check) => check.id).join(', ')}.`,
    )
  }
  return {
    ok: true,
    codexExecutable,
    layer,
    configFile: targets.configFile,
    hooksFile: targets.hooksFile,
    checks,
    covered: [...report.matrix.covered],
    uncovered: [...report.matrix.uncovered],
    notice: report.matrix.notice,
    warnings: [...extraWarnings],
  }
}

async function runClaudeDoctor(flags: Record<string, unknown>): Promise<unknown> {
  const scope = flags['scope'] as 'user' | 'project' | 'local'
  const override = flags['claude-version'] as string | undefined
  assertClaudeVersionOverrideAllowed(override)
  const detected = override ?? (await readInstalledClaudeVersion())
  const layout = resolveClaudeLayout({
    projectDirectory: flags['project-dir'] as string | undefined,
  })
  const result = await planClaudeDoctor({
    layout,
    scope,
    sessionId: (flags['session'] as string | undefined) ?? null,
    claudeVersionRaw: detected,
    files: liveFileAccess(),
  })
  if (!result.ok) process.exitCode = 1
  return result
}

export default class AgentDoctor extends OcboxCommand {
  static override description =
    'Diagnose a coding-agent routing adapter (version, precedence, drift, capabilities)'
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
      description: 'Claude-code settings scope owned by the adapter',
      options: ['user', 'project', 'local'],
      default: 'project',
    }),
    session: Flags.string({ description: 'Session ID to evaluate for remote routing' }),
    'codex-home': Flags.string({ description: 'Override CODEX_HOME for Codex discovery' }),
    'project-dir': Flags.string({ description: 'Project directory for the project layer' }),
    'claude-version': Flags.string({
      description: `Override detected version (claude-code offline test harness only, requires ${TEST_HARNESS_ENV}=1; pinned ${PINNED_CLAUDE_CODE_VERSION})`,
    }),
  }

  async run(): Promise<void> {
    const { args, flags, metadata } = await this.parse(AgentDoctor)
    const adapter = String(args.adapter ?? '')
    const flagRecord = flags as unknown as Record<string, unknown>
    const isProvided = flagProvidedChecker(flagRecord, metadata as FlagMetadata | undefined)
    if (adapter === 'codex') {
      const flagWarnings = irrelevantFlagWarnings('codex', 'doctor', isProvided)
      await this.emitResult(
        flags,
        'agent.codex.doctor',
        (result: unknown) => JSON.stringify(result),
        async () => runCodexDoctor(flagRecord, flagWarnings),
      )
      return
    }
    if (adapter === 'claude-code') {
      warnIrrelevantFlags('claude-code', 'doctor', isProvided)
      await this.emitResult(
        flags,
        'agent.doctor',
        (result: { ok: boolean; targetPath: string }) =>
          result.ok ? `healthy: ${result.targetPath}` : `issues found: ${result.targetPath}`,
        async () =>
          runClaudeDoctor(flags as unknown as Record<string, unknown>) as Promise<{
            ok: boolean
            targetPath: string
          }>,
      )
      return
    }
    throw new Error(`unknown adapter "${adapter}"; only "codex", "claude-code" are supported`)
  }
}

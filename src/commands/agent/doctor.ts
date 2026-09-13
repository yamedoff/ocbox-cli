import { Args, Flags } from '@oclif/core'
import {
  codexDoctor,
  detectCodexExecutable,
  determineProjectTrust,
  layerTargetFiles,
  manifestFile,
  manifestPathForLayer,
  parseCodexToml,
  parseLegacyCodexManifest,
  projectTrustLevel,
  readManifestSafe,
  readTextOrNull,
  resolveAgentCodexPaths,
  resolveSessionSelection,
  runCodexVersion,
} from '../../agents/codex/index.js'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'
import { resolveStateDirectory } from '../../cli/runtime.js'

export default class AgentDoctor extends OcboxCommand {
  static override description = 'Check the Codex routing adapter without changing anything'
  static override args = {
    adapter: Args.string({
      required: true,
      description: 'Adapter name (only "codex" is supported)',
    }),
  }
  static override flags = {
    ...runtimeFlags,
    layer: Flags.string({ description: 'Config layer: user or project (default user)' }),
    session: Flags.string({ description: 'Session ID to evaluate for remote routing' }),
    'codex-home': Flags.string({ description: 'Override CODEX_HOME for Codex discovery' }),
    'project-dir': Flags.string({ description: 'Project directory for the project layer' }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentDoctor)
    if (args['adapter'] !== 'codex') {
      throw new Error(`Unknown agent adapter "${args['adapter']}"; only "codex" is supported.`)
    }
    const layer = flags['layer'] === 'project' ? 'project' : 'user'
    if (flags['layer'] !== undefined && flags['layer'] !== 'user' && flags['layer'] !== 'project') {
      throw new Error(`Unknown layer "${flags['layer']}"; use user or project.`)
    }
    await this.emitResult(
      flags,
      'agent.codex.doctor',
      (result: unknown) => JSON.stringify(result),
      async () => {
        const stateDirectory = resolveStateDirectory(flags)
        const paths = resolveAgentCodexPaths({
          ...(flags['codex-home'] === undefined ? {} : { codexHome: flags['codex-home'] }),
          ...(flags['project-dir'] === undefined ? {} : { projectDir: flags['project-dir'] }),
          stateDirectory,
        })
        const targets = layerTargetFiles(paths, layer)
        const codexExecutable = detectCodexExecutable() ?? 'codex'
        const versionText = await runCodexVersion(codexExecutable)
        const tomlText = await readTextOrNull(targets.configFile)
        const hooksText = await readTextOrNull(targets.hooksFile)
        const projectDirectory = paths.projectDirectory ?? process.cwd()
        const { manifest, warning } = await readManifestSafe(
          manifestPathForLayer(stateDirectory, layer),
        )
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
          flags['session'] ?? manifest?.sessionId,
        )
        let trustLevel: string | null = null
        if (layer === 'project') {
          const userToml = await readTextOrNull(paths.userConfigFile)
          const determined = determineProjectTrust(userToml, projectDirectory)
          trustLevel =
            determined === 'trusted'
              ? 'trusted'
              : (projectTrustLevel(tomlText, [projectDirectory], (text: string) =>
                  parseCodexToml(text),
                ) ?? determined)
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
        }
      },
    )
  }
}

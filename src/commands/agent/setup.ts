import { Args, Flags } from '@oclif/core'
import {
  applyCodexChangePlan,
  assertAdapterOwnedPath,
  determineProjectTrust,
  layerTargetFiles,
  manifestPathForLayer,
  manifestFile,
  nodeCodexFileSystem,
  parseCodexToml,
  planCodexSetup,
  projectTrustLevel,
  readManifestSafe,
  readTextOrNull,
  resolveAgentCodexPaths,
  resolveSessionSelection,
  runCodexVersion,
  detectCodexExecutable,
  type CodexLayer,
} from '../../agents/codex/index.js'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'
import { resolveStateDirectory } from '../../cli/runtime.js'

function parseLayer(raw: string | undefined): CodexLayer {
  if (raw === undefined || raw === 'user') return 'user'
  if (raw === 'project') return 'project'
  throw new Error(`Unknown layer "${raw}"; use user or project.`)
}

export default class AgentSetup extends OcboxCommand {
  static override description =
    'Plan or apply the Codex routing adapter fragments (explicit, idempotent, fail-closed)'
  static override args = {
    adapter: Args.string({
      required: true,
      description: 'Adapter name (only "codex" is supported)',
    }),
  }
  static override flags = {
    ...runtimeFlags,
    layer: Flags.string({ description: 'Config layer: user or project (default user)' }),
    session: Flags.string({
      description: 'Session ID for remote routing; defaults to the selected Session',
    }),
    'codex-home': Flags.string({ description: 'Override CODEX_HOME for Codex discovery' }),
    'project-dir': Flags.string({ description: 'Project directory for the project layer' }),
    'allow-unverified-schema': Flags.boolean({
      description:
        'Deprecated no-op: the pinned schema gate now proves the hooks shape, so setup proceeds without it',
    }),
    yes: Flags.boolean({ description: 'Apply the plan; without it only the plan is printed' }),
    'ocbox-bin': Flags.string({ description: 'ocbox binary invoked by the owned hook' }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentSetup)
    if (args['adapter'] !== 'codex') {
      throw new Error(`Unknown agent adapter "${args['adapter']}"; only "codex" is supported.`)
    }
    const layer = parseLayer(flags['layer'])
    await this.emitResult(
      flags,
      'agent.codex.setup',
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
        const baseTomlText = await readTextOrNull(targets.configFile)
        const baseHooksText = await readTextOrNull(targets.hooksFile)
        const projectDirectory = paths.projectDirectory ?? process.cwd()
        let trustLevel: string | null = null
        if (layer === 'project') {
          const userToml = await readTextOrNull(paths.userConfigFile)
          const determined = determineProjectTrust(userToml, projectDirectory)
          trustLevel =
            determined === 'trusted'
              ? 'trusted'
              : (projectTrustLevel(baseTomlText, [projectDirectory], (text: string) =>
                  parseCodexToml(text),
                ) ?? determined)
        }
        const selection = await resolveSessionSelection(
          stateDirectory,
          projectDirectory,
          flags['session'],
        )
        const layeredManifestPath = manifestPathForLayer(stateDirectory, layer)
        const { manifest, warning: layeredWarning } = await readManifestSafe(layeredManifestPath)
        let warning = layeredWarning
        if (manifest === null && warning === null) {
          const legacy = await readTextOrNull(manifestFile(stateDirectory))
          if (legacy !== null) {
            warning =
              'A legacy single-layer manifest exists; it is ignored by this adapter version. Re-run setup to record per-layer ownership.'
          }
        }
        const plan = planCodexSetup(
          {
            versionText,
            layer,
            trustLevel,
            sessionId: selection.sessionId,
            allowUnverifiedSchema: flags['allow-unverified-schema'] === true,
            paths,
            baseTomlText,
            baseHooksText,
            ...(flags['ocbox-bin'] === undefined ? {} : { ocboxBin: flags['ocbox-bin'] }),
          },
          manifest,
        )
        const warnings = warning === null ? [...plan.warnings] : [warning, ...plan.warnings]
        if (!plan.ok) {
          if (flags['yes'] === true) throw new Error(plan.errors.join(' '))
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
        for (const change of plan.changes) {
          if (change.kind === 'manifest') continue
          const root =
            change.file === plan.configFile || change.file === plan.hooksFile
              ? paths.codexHome
              : (paths.projectRoot ?? paths.codexHome)
          assertAdapterOwnedPath(change.file, root, paths.platform)
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
      },
    )
  }
}

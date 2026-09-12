import { Args, Flags } from '@oclif/core'
import {
  backupFileTo,
  backupTimestamp,
  detectCodexExecutable,
  layerTargetFiles,
  manifestBackupDirectory,
  manifestFile,
  parseCodexToml,
  planCodexSetup,
  projectTrustLevel,
  readManifestSafe,
  readTextOrNull,
  resolveAgentCodexPaths,
  resolveSessionSelection,
  runCodexVersion,
  writeFileAtomic,
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
        'Apply the documented fixture representation while the hook schema is unverified',
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
        const paths = resolveAgentCodexPaths({
          ...(flags['codex-home'] === undefined ? {} : { codexHome: flags['codex-home'] }),
          ...(flags['project-dir'] === undefined ? {} : { projectDir: flags['project-dir'] }),
        })
        const targets = layerTargetFiles(paths, layer)
        const codexExecutable = detectCodexExecutable() ?? 'codex'
        const versionText = await runCodexVersion(codexExecutable)
        const baseTomlText = await readTextOrNull(targets.configFile)
        const baseHooksText = await readTextOrNull(targets.hooksFile)
        const projectDirectory = paths.projectDirectory ?? process.cwd()
        const trustLevel =
          layer === 'project'
            ? projectTrustLevel(baseTomlText, [projectDirectory], (text: string) =>
                parseCodexToml(text),
              )
            : null
        const stateDirectory = resolveStateDirectory(flags)
        const selection = await resolveSessionSelection(
          stateDirectory,
          projectDirectory,
          flags['session'],
        )
        const { manifest, warning } = await readManifestSafe(manifestFile(stateDirectory))
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
        const timestamp = backupTimestamp()
        const backupDirectory = manifestBackupDirectory(stateDirectory)
        let backupConfigPath: string | null = null
        let backupHooksPath: string | null = null
        for (const change of plan.changes) {
          const backup = await backupFileTo(change.file, backupDirectory, timestamp)
          if (change.kind === 'toml-merge') backupConfigPath = backup
          else backupHooksPath = backup
          await writeFileAtomic(change.file, change.after)
        }
        const appliedAt = new Date().toISOString()
        const tomlChange = plan.changes.find((change) => change.kind === 'toml-merge')
        const hooksChange = plan.changes.find((change) => change.kind === 'hooks-write')
        const manifestText = JSON.stringify(
          {
            schemaVersion: 1,
            adapter: 'codex',
            adapterVersion: 'ocbox-codex-adapter-v1',
            codexVersion: plan.detectedVersion ?? 'unknown',
            layer: plan.layer,
            codexHome: paths.codexHome,
            projectDirectory: paths.projectDirectory,
            configFile: plan.configFile,
            hooksFile: plan.hooksFile,
            hookRepresentation: 'hooks-json',
            sessionId: selection.sessionId ?? '',
            ownedTomlText: tomlChange?.after ?? manifest?.ownedTomlText ?? '',
            ownedHooksText: hooksChange?.after ?? manifest?.ownedHooksText ?? '',
            backupConfigPath,
            backupHooksPath,
            createdAt: manifest?.createdAt ?? appliedAt,
            updatedAt: appliedAt,
          },
          null,
          2,
        )
        await writeFileAtomic(manifestFile(stateDirectory), `${manifestText}\n`)
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

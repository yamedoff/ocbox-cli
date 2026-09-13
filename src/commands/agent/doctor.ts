import { Args, Flags } from '@oclif/core'
import { readInstalledClaudeVersion } from '../../agents/claude-code/claude-executable.js'
import { liveFileAccess, planDoctor } from '../../agents/claude-code/planner.js'
import { resolveClaudeSettingsLayout as resolveLayout } from '../../agents/claude-code/settings-sources.js'
import {
  assertClaudeVersionOverrideAllowed,
  PINNED_CLAUDE_CODE_VERSION,
  TEST_HARNESS_ENV,
} from '../../agents/claude-code/version.js'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'

export default class AgentDoctor extends OcboxCommand {
  static override description =
    'Diagnose the claude-code routing adapter (version, precedence, drift, capabilities)'
  static override args = {
    adapter: Args.string({ required: true, description: 'Adapter name (only claude-code)' }),
  }
  static override flags = {
    ...runtimeFlags,
    scope: Flags.string({
      description: 'Settings scope owned by the adapter',
      options: ['user', 'project', 'local'],
      default: 'project',
    }),
    session: Flags.string({ description: 'Selected Session ID for covered shell routing' }),
    'project-dir': Flags.string({ description: 'Project directory owning .claude settings' }),
    'claude-version': Flags.string({
      description: `Override detected version (offline test harness only, requires ${TEST_HARNESS_ENV}=1; pinned ${PINNED_CLAUDE_CODE_VERSION})`,
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentDoctor)
    await this.emitResult(
      flags,
      'agent.doctor',
      (result: { ok: boolean; targetPath: string }) =>
        result.ok ? `healthy: ${result.targetPath}` : `issues found: ${result.targetPath}`,
      async () => {
        const adapter = String(args.adapter ?? '')
        if (adapter !== 'claude-code') {
          throw new Error(`unknown adapter "${adapter}"; only "claude-code" is supported`)
        }
        const scope = flags.scope as 'user' | 'project' | 'local'
        const override = flags['claude-version']
        assertClaudeVersionOverrideAllowed(override)
        const detected = override ?? (await readInstalledClaudeVersion())
        const layout = resolveLayout({ projectDirectory: flags['project-dir'] })
        const result = await planDoctor({
          layout,
          scope,
          sessionId: flags.session ?? null,
          claudeVersionRaw: detected,
          files: liveFileAccess(),
        })
        if (!result.ok) process.exitCode = 1
        return result
      },
    )
  }
}

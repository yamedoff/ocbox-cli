import { Command } from '@oclif/core'

const USAGE = [
  'Manage coding-agent routing adapters.',
  '',
  'USAGE',
  '  $ ocbox agent setup codex [--layer user|project] [--session SESSION_ID] [--yes]',
  '  $ ocbox agent doctor codex [--layer user|project] [--session SESSION_ID]',
  '  $ ocbox agent remove codex [--layer user|project|all] [--yes]',
  '  $ ocbox agent hook codex --session SESSION_ID   # internal PreToolUse hook (stdin JSON)',
  '  $ ocbox agent setup claude-code [--scope user|project|local] [--session SESSION_ID]',
  '  $ ocbox agent doctor claude-code [--scope user|project|local] [--session SESSION_ID]',
  '  $ ocbox agent remove claude-code [--scope user|project|local]',
  '  $ ocbox agent hook claude-code --session SESSION_ID   # internal PreToolUse hook (stdin JSON)',
  '',
  'ADAPTERS',
  '  codex        Reversible routing aid for Codex (pinned version only)',
  '  claude-code  Reversible routing aid for Claude Code (pinned version only)',
  '',
  'NOTES',
  '  Routing aid, not host isolation. Covered shell calls route through ocbox exec.',
  '  Source moves only through explicit ocbox sync. Hooks stay under the hooks key.',
  '  Codex setup/remove print a plan without --yes and apply it with --yes;',
  '  a refused codex plan still prints its JSON but exits 2. Flags owned by',
  '  the other adapter are ignored with an explicit warning.',
].join('\n')

export default class AgentTopic extends Command {
  static override description = 'Manage coding-agent routing adapters'
  static override flags = {}

  async run(): Promise<void> {
    this.log(USAGE)
  }
}

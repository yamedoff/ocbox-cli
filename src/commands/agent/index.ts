import { Command } from '@oclif/core'

const USAGE = [
  'Manage coding-agent routing adapters.',
  '',
  'USAGE',
  '  $ ocbox agent setup claude-code [--scope user|project|local] [--session SESSION_ID]',
  '  $ ocbox agent doctor claude-code [--scope user|project|local] [--session SESSION_ID]',
  '  $ ocbox agent remove claude-code [--scope user|project|local]',
  '',
  'ADAPTERS',
  '  claude-code  Reversible routing aid for Claude Code (pinned version only)',
  '',
  'NOTES',
  '  Routing aid, not host isolation. Covered shell calls route through ocbox exec.',
  '  Source moves only through explicit ocbox sync. Hooks stay under the hooks key.',
].join('\n')

export default class AgentTopic extends Command {
  static override description = 'Manage coding-agent routing adapters'
  static override flags = {}

  async run(): Promise<void> {
    this.log(USAGE)
  }
}

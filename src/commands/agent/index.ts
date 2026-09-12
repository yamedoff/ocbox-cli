import { Command } from '@oclif/core'

const USAGE = [
  'Manage the reversible Codex routing adapter (a routing aid, not host isolation).',
  '',
  'USAGE',
  '  $ ocbox agent setup codex [--layer user|project] [--session SESSION_ID] [--yes]',
  '  $ ocbox agent doctor codex',
  '  $ ocbox agent remove codex [--layer user|project|all] [--yes]',
  '',
  'COMMANDS',
  '  setup   Plan or apply the owned config and hook fragments (idempotent)',
  '  doctor  Check version, config, trust, owned entries, Session, and drift',
  '  remove  Restore only owned fragments, preserving user edits',
].join('\n')

export default class AgentTopic extends Command {
  static override description = 'Manage coding-agent routing adapters'
  static override flags = {}

  async run(): Promise<void> {
    this.log(USAGE)
  }
}

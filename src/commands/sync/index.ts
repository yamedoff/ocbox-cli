import { Command } from '@oclif/core'

const USAGE = [
  'Transfer source between the local workspace and a Session workspace.',
  '',
  'USAGE',
  '  $ ocbox sync diff [--session SESSION_ID]',
  '  $ ocbox sync push [--session SESSION_ID] [--delete] [--yes]',
  '  $ ocbox sync pull [--session SESSION_ID] [--delete] [--yes]',
  '  $ ocbox sync recover [--session SESSION_ID]',
  '',
  'COMMANDS',
  '  diff     Compare local, remote, and the last verified baseline (read-only)',
  '  push     Apply local-only changes to the Session workspace',
  '  pull     Apply remote-only changes to the local workspace',
  '  recover  Resolve an interrupted transfer that requires recovery',
].join('\n')

/** Topic command so `ocbox sync` prints usage instead of an unknown-command error. */
export default class SyncTopic extends Command {
  static override description = 'Inspect and transfer source for a Session'
  static override flags = {}

  async run(): Promise<void> {
    this.log(USAGE)
  }
}

import { Command } from '@oclif/core'

export const SYNC_USAGE = [
  'Transfer source between the local workspace and a Session workspace. On hosted boxes, push uploads local files to the box, pull downloads changed box files, and diff compares local files with the box.',
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
  '  recover  Resolve an interrupted local transfer (fake provider only)',
].join('\n')

/** Topic command so `ocbox sync` prints usage instead of an unknown-command error. */
export default class SyncTopic extends Command {
  static override description =
    'Inspect and transfer source for a Session. On hosted boxes, push uploads local files, pull downloads changed box files, and diff compares local files with the box.'
  static override flags = {}

  async run(): Promise<void> {
    this.log(SYNC_USAGE)
  }
}

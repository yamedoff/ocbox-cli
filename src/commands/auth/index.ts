import { Command } from '@oclif/core'

const USAGE = [
  'Manage the hosted OAuth 2.1 login for this machine.',
  '',
  'USAGE',
  '  $ ocbox auth login --api-url URL [--no-browser]',
  '  $ ocbox auth status',
  '  $ ocbox auth logout',
  '',
  'COMMANDS',
  '  login   Authorize the public CLI client with S256 PKCE over a loopback callback',
  '  status  Report login, expiry, scope, and audience facts (never secret values)',
  '  logout  Revoke the hosted credential when possible and clear local material',
].join('\n')

/** Topic command so `ocbox auth` prints usage instead of an unknown-command error. */
export default class AuthTopic extends Command {
  static override description = 'Authenticate the CLI with the hosted service'
  static override flags = {}

  async run(): Promise<void> {
    this.log(USAGE)
  }
}

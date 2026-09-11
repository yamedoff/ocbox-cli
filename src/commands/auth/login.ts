import { Flags } from '@oclif/core'
import { createAuthSessionService, resolveAuthEndpoints } from '../../auth/runtime.js'
import { authLoginLine } from '../../auth/views.js'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'

export default class AuthLogin extends OcboxCommand {
  static override description =
    'Authorize the public CLI client with OAuth 2.1 authorization-code and S256 PKCE'
  static override flags = {
    ...runtimeFlags,
    'api-url': Flags.string({
      description: 'Hosted API base URL; defaults to OCBOX_API_URL',
    }),
    'authorize-url': Flags.string({
      description: 'Override the browser authorization endpoint',
    }),
    'no-browser': Flags.boolean({
      description: 'Print the authorization URL instead of opening a browser',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(AuthLogin)
    const writer = this.writerFor(flags)
    try {
      const session = createAuthSessionService({
        endpoints: resolveAuthEndpoints(flags),
        flags,
      })
      const result = await session.login({
        openBrowser: flags['no-browser'] !== true,
        onAuthorizationUrl: (authorizationUrl, opened) => {
          if (!opened) {
            writer.event(
              'auth.authorization_url',
              { url: authorizationUrl },
              {
                humanMessage: `Open this URL to authorize the CLI:\n${authorizationUrl}`,
              },
            )
          }
        },
      })
      writer.result('auth.logged_in', result, { humanMessage: authLoginLine(result) })
    } catch (error) {
      writer.error(error)
      process.exitCode = 1
    }
  }
}

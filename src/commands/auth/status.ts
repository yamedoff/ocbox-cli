import { readHostedIdentity } from '../../auth/identity.js'
import { createAuthSessionService } from '../../auth/runtime.js'
import { authStatusLine } from '../../auth/views.js'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'

export default class AuthStatus extends OcboxCommand {
  static override description =
    'Report hosted login, expiry, scope, and audience facts without exposing secret values'
  static override flags = runtimeFlags

  async run(): Promise<void> {
    const { flags } = await this.parse(AuthStatus)
    const session = createAuthSessionService({ endpoints: null, flags })
    await this.emitResult(flags, 'auth.status', authStatusLine, async () => {
      let status = await session.status()
      if (!status.loggedIn) {
        process.exitCode = 1
        return status
      }
      // The token's own identity is the authority for expiry; stored local
      // metadata is a cache and may not carry one.
      try {
        const identity = await readHostedIdentity(flags)
        status = { ...status, expiresAt: identity.expiresAt }
      } catch {
        /* Keep the stored facts when the identity endpoint is unavailable. */
      }
      return status
    })
  }
}

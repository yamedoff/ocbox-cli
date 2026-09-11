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
    await this.emitResult(flags, 'auth.status', authStatusLine, () => session.status())
  }
}

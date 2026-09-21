import { createAuthSessionService } from '../../auth/runtime.js'
import { authLogoutLine } from '../../auth/views.js'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'

export default class AuthLogout extends OcboxCommand {
  static override description =
    'Revoke the hosted credential when possible and always clear local credential material'
  static override flags = runtimeFlags

  async run(): Promise<void> {
    const { flags } = await this.parse(AuthLogout)
    const session = createAuthSessionService({ endpoints: null, flags })
    await this.emitResult(flags, 'auth.logged_out', authLogoutLine, () => session.logout())
  }
}

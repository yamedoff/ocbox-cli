import { randomUUID } from 'node:crypto'
import { createAuthSessionService } from '../auth/runtime.js'
import { RequestIdSchema, UtcTimestampSchema } from '../contracts.js'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { createRegistry, loadProjectConfig, resolveStateDirectory } from '../cli/runtime.js'

export default class Providers extends OcboxCommand {
  static override description = 'Show provider availability, authentication, and capabilities'
  static override flags = runtimeFlags

  async run(): Promise<void> {
    const { flags } = await this.parse(Providers)
    await this.emitResult(
      flags,
      'providers.inspected',
      (result) =>
        result.providers
          .map(
            (provider) =>
              `${provider.name} available=${String(provider.available)} auth=${provider.auth}`,
          )
          .join('\n'),
      async () => {
        const config = await loadProjectConfig(flags)
        const registry = createRegistry(resolveStateDirectory(flags), undefined, process.env, {
          apiUrl: flags['api-url'],
          projectId: flags.project ?? process.env['OCBOX_PROJECT_ID'] ?? config.projectId,
        })
        const requestId = RequestIdSchema.parse(randomUUID())
        const providers = await registry.diagnostics({
          requestId,
          issuedAt: UtcTimestampSchema.parse(new Date().toISOString()),
        })
        // `providers` must report the same login state as the hosted commands.
        // A readable metadata record with an unexpired credential means the
        // ocbox provider is authenticated; a missing/stale login means required.
        let hostedAuth: 'ok' | 'required' = 'required'
        try {
          const status = await createAuthSessionService({ endpoints: null, flags }).status()
          hostedAuth = status.loggedIn ? 'ok' : 'required'
        } catch {
          hostedAuth = 'required'
        }
        return {
          configuredProvider: config.provider.name,
          providers: providers.map((provider) =>
            provider.name === 'ocbox' ? { ...provider, auth: hostedAuth } : provider,
          ),
        }
      },
    )
  }
}

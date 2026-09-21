import { randomUUID } from 'node:crypto'
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
        const registry = createRegistry(resolveStateDirectory(flags))
        const requestId = RequestIdSchema.parse(randomUUID())
        return {
          configuredProvider: config.provider.name,
          providers: await registry.diagnostics({
            requestId,
            issuedAt: UtcTimestampSchema.parse(new Date().toISOString()),
          }),
        }
      },
    )
  }
}

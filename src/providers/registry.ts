import { RequestIdSchema, type RequestContext, type SandboxProvider } from '../contracts.js'
import { OcboxError } from '../errors/index.js'

export interface ProviderDiagnostic {
  readonly name: string
  readonly available: boolean
  readonly auth: 'not_required' | 'configured' | 'required'
  readonly capabilities: Awaited<ReturnType<SandboxProvider['capabilities']>> | null
  readonly errorCode: 'PROVIDER_UNAVAILABLE' | null
}

export type ProviderFactory = () => SandboxProvider

/** Provider-neutral slug registry; commands never branch on provider names. */
export class ProviderRegistry {
  readonly #factories = new Map<string, ProviderFactory>()

  register(slug: string, factory: ProviderFactory): this {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(slug)) throw new TypeError('Invalid provider slug')
    if (this.#factories.has(slug)) throw new TypeError(`Provider ${slug} is already registered`)
    this.#factories.set(slug, factory)
    return this
  }

  slugs(): readonly string[] {
    return [...this.#factories.keys()].sort()
  }

  resolve(slug: string, requestId = RequestIdSchema.parse(crypto.randomUUID())): SandboxProvider {
    const factory = this.#factories.get(slug)
    if (factory === undefined) {
      throw new OcboxError({
        code: 'CONFIG_INVALID',
        message: `Unknown provider ${slug}; run ocbox providers to list available providers`,
        requestId,
        details: { provider: slug },
      })
    }
    try {
      return factory()
    } catch {
      throw new OcboxError({
        code: 'PROVIDER_UNAVAILABLE',
        message: `Provider ${slug} is unavailable`,
        requestId,
        details: { provider: slug },
      })
    }
  }

  async diagnostics(context: RequestContext): Promise<readonly ProviderDiagnostic[]> {
    return Promise.all(
      this.slugs().map(async (name) => {
        try {
          const provider = this.resolve(name, context.requestId)
          return {
            name,
            available: true,
            auth: 'not_required' as const,
            capabilities: await provider.capabilities(context),
            errorCode: null,
          }
        } catch {
          return {
            name,
            available: false,
            auth: 'required' as const,
            capabilities: null,
            errorCode: 'PROVIDER_UNAVAILABLE' as const,
          }
        }
      }),
    )
  }
}

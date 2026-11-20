import { createRequire } from 'node:module'

let cached: string | undefined

/**
 * The version of the running package. Self-reference through the package's
 * own `exports` map works from the source tree and from every installed layout,
 * and does not depend on where a bundler places the compiled entry point.
 */
export function cliVersion(): string {
  if (cached !== undefined) return cached
  const localRequire = createRequire(import.meta.url)
  const manifest = localRequire('opencloudbox/package.json') as { version?: unknown }
  cached = typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  return cached
}

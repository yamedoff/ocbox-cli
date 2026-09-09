import { matchesGlob } from 'node:path'
import type { ManifestPath } from './path-policy.js'

export type ExclusionReason =
  | 'build-cache'
  | 'dependency-cache'
  | 'git-metadata'
  | 'key-material'
  | 'os-or-browser-store'
  | 'provider-credential-store'
  | 'secret-environment'
  | 'user-rule'

const DEPENDENCY_OR_CACHE_SEGMENTS = new Set([
  '.cache',
  '.next',
  '.nuxt',
  '.pnpm-store',
  '.turbo',
  '.yarn',
  '__pycache__',
  'bower_components',
  'node_modules',
  'vendor',
])
const BUILD_SEGMENTS = new Set(['build', 'coverage', 'dist', 'out', 'target'])
const KEY_FILE = /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:key|pem|p12|pfx|kdbx))$/i
const OS_OR_BROWSER = /(?:^|\/)(?:Cookies|Login Data|Keychains?|Local State|Web Data)(?:\/|$)/i
const PROVIDER_STORE = /(?:^|\/)(?:\.aws|\.azure|\.config\/gcloud|\.docker|\.kube)(?:\/|$)/i

/** Returns an unoverrideable exclusion before user-authored rules run. */
export function builtInExclusion(path: ManifestPath): ExclusionReason | null {
  const segments = path.split('/')
  if (segments.includes('.git')) return 'git-metadata'
  if (segments.some((segment) => DEPENDENCY_OR_CACHE_SEGMENTS.has(segment))) {
    return 'dependency-cache'
  }
  if (segments.some((segment) => BUILD_SEGMENTS.has(segment))) return 'build-cache'
  const name = segments.at(-1) ?? ''
  if (/^\.env(?:\..*)?$/i.test(name)) return 'secret-environment'
  if (KEY_FILE.test(path)) return 'key-material'
  if (PROVIDER_STORE.test(path)) return 'provider-credential-store'
  if (OS_OR_BROWSER.test(path) || name === '.DS_Store' || name === 'Thumbs.db') {
    return 'os-or-browser-store'
  }
  return null
}

export interface IgnoreRule {
  readonly include: boolean
  readonly pattern: string
  readonly source: 'cli' | 'gitignore' | 'opencloudboxignore'
}

export class InvalidIgnoreRuleError extends Error {
  constructor(readonly line: number) {
    super(`Invalid ignore rule at line ${line}`)
    this.name = 'InvalidIgnoreRuleError'
  }
}

export function parseIgnoreRules(
  contents: string,
  source: IgnoreRule['source'],
): readonly IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const [index, original] of contents.split(/\r?\n/).entries()) {
    const line = original.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const include = line.startsWith('!')
    let pattern = include ? line.slice(1) : line
    if (
      pattern.length === 0 ||
      pattern.includes('\\') ||
      pattern.includes('\0') ||
      pattern.startsWith('/') ||
      pattern.split('/').includes('..')
    ) {
      throw new InvalidIgnoreRuleError(index + 1)
    }
    if (pattern.endsWith('/')) pattern = `${pattern}**`
    if (!pattern.includes('/')) pattern = `**/${pattern}`
    rules.push({ include, pattern, source })
  }
  return rules
}

/**
 * Applies gitignore, then .opencloudboxignore, then CLI rules. Built-ins are
 * evaluated first and cannot be re-included by a negated rule.
 */
export function exclusionForPath(
  path: ManifestPath,
  ruleGroups: readonly (readonly IgnoreRule[])[],
): ExclusionReason | null {
  const builtIn = builtInExclusion(path)
  if (builtIn !== null) return builtIn
  let excluded = false
  for (const rules of ruleGroups) {
    for (const rule of rules) {
      if (matchesGlob(path, rule.pattern)) excluded = !rule.include
    }
  }
  return excluded ? 'user-rule' : null
}

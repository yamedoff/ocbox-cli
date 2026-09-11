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

// Segment sets are stored lowercase and compared case-insensitively so a
// rename such as `.GIT` or `NODE_MODULES` cannot bypass a built-in exclusion on
// a case-insensitive filesystem.
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
const KEY_OR_CREDENTIAL_DIRECTORIES = new Set(['.gnupg', '.password-store', '.ssh'])
const CREDENTIAL_FILE_NAMES = new Set([
  '.git-credentials',
  '.htpasswd',
  '.my.cnf',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.pypirc',
  '_netrc',
])
// FIDO2 security-key variants (`*_sk`) sit beside the classic private-key names.
const KEY_FILE =
  /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|identity|[^/]+\.(?:asc|gpg|jks|kdbx|key|keystore|p12|p8|pem|pfx|pgp|pkcs12|ppk))$/i
// Browser password stores beyond Chromium's cookie database names. `logins.json`
// and `key4.db` hold every Firefox credential; `Cookies`/`Login Data` cover Chromium.
const OS_OR_BROWSER =
  /(?:^|\/)(?:Cookies|Login Data|Keychains?|Local State|Web Data|key4\.db|logins(?:-backup)?\.json|signons.*\.sqlite)(?:\/|$)/i
// Cloud CLI credential stores: OCI, Vercel, Netlify and the legacy AWS/GCS hosts.
const PROVIDER_STORE =
  /(?:^|\/)(?:\.aws|\.azure|\.config\/gcloud|\.docker|\.gsutil|\.kube|\.netlify|\.oci|\.vercel)(?:\/|$)/i

/** Returns an unoverrideable exclusion before user-authored rules run. */
export function builtInExclusion(path: ManifestPath): ExclusionReason | null {
  const segments = path.split('/')
  const lowerSegments = segments.map((segment) => segment.toLowerCase())
  if (lowerSegments.includes('.git')) return 'git-metadata'
  if (lowerSegments.some((segment) => DEPENDENCY_OR_CACHE_SEGMENTS.has(segment))) {
    return 'dependency-cache'
  }
  if (lowerSegments.some((segment) => BUILD_SEGMENTS.has(segment))) return 'build-cache'
  const name = segments.at(-1) ?? ''
  const lowerName = name.toLowerCase()
  // AC4 `.env*` in glob semantics also covers `.envrc` (direnv) and similar names.
  if (/^\.env/i.test(name)) return 'secret-environment'
  if (KEY_FILE.test(path)) return 'key-material'
  if (lowerSegments.some((segment) => KEY_OR_CREDENTIAL_DIRECTORIES.has(segment))) {
    return 'key-material'
  }
  if (CREDENTIAL_FILE_NAMES.has(lowerName)) return 'provider-credential-store'
  if (PROVIDER_STORE.test(path)) return 'provider-credential-store'
  if (OS_OR_BROWSER.test(path) || lowerName === '.ds_store' || lowerName === 'thumbs.db') {
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
    // A trailing slash targets a directory. `matchesGlob(dir, 'dir/**')` does not
    // match the directory itself, so the bare segment gets its own rule as well.
    if (pattern.endsWith('/')) {
      let directory = pattern.slice(0, -1)
      if (directory.length === 0) throw new InvalidIgnoreRuleError(index + 1)
      if (!directory.includes('/')) directory = `**/${directory}`
      rules.push({ include, pattern: directory, source })
      rules.push({ include, pattern: `${directory}/**`, source })
      continue
    }
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

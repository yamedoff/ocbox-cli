import { describe, expect, it } from 'vitest'
import {
  builtInExclusion,
  exclusionForPath,
  InvalidIgnoreRuleError,
  parseIgnoreRules,
} from '../../src/sync/exclusions.js'
import { normalizeManifestPath } from '../../src/sync/path-policy.js'

const path = (value: string) => normalizeManifestPath(value)

describe('sync exclusions', () => {
  it.each([
    ['.git/config', 'git-metadata'],
    ['node_modules/tool/index.js', 'dependency-cache'],
    ['packages/web/dist/app.js', 'build-cache'],
    ['.env.production', 'secret-environment'],
    ['keys/id_ed25519', 'key-material'],
    ['cert/client.p12', 'key-material'],
    ['.aws/credentials', 'provider-credential-store'],
    ['Library/Keychain/data', 'os-or-browser-store'],
  ] as const)('blocks %s as %s', (value, reason) => {
    expect(builtInExclusion(path(value))).toBe(reason)
  })

  it.each([
    ['.GIT/config', 'git-metadata'],
    ['NODE_MODULES/tool/index.js', 'dependency-cache'],
    ['packages/web/DIST/app.js', 'build-cache'],
    ['.SSH/id_rsa', 'key-material'],
    ['.ssh/config', 'key-material'],
    ['.gnupg/private-keys-v1.d/key', 'key-material'],
    ['vault/.password-store/site.gpg', 'key-material'],
    ['secrets/server.keystore', 'key-material'],
    ['.netrc', 'provider-credential-store'],
    ['.git-credentials', 'provider-credential-store'],
    ['.npmrc', 'provider-credential-store'],
  ] as const)('resists case and store bypass for %s', (value, reason) => {
    expect(builtInExclusion(path(value))).toBe(reason)
  })

  it('uses deterministic rule-source precedence', () => {
    const git = parseIgnoreRules('*.log\n!important.log', 'gitignore')
    const ocbox = parseIgnoreRules('important.log', 'opencloudboxignore')
    const cli = parseIgnoreRules('!important.log', 'cli')
    expect(exclusionForPath(path('debug.log'), [git, ocbox, cli])).toBe('user-rule')
    expect(exclusionForPath(path('important.log'), [git, ocbox, cli])).toBeNull()
  })

  it('never lets an include rule weaken built-in secret exclusions', () => {
    const include = parseIgnoreRules('!.env*\n!.aws/**\n!.GIT/**', 'cli')
    expect(exclusionForPath(path('.env.local'), [include])).toBe('secret-environment')
    expect(exclusionForPath(path('.aws/credentials'), [include])).toBe('provider-credential-store')
    expect(exclusionForPath(path('.GIT/config'), [include])).toBe('git-metadata')
  })

  it.each([
    ['.envrc', 'secret-environment'],
    ['.ENVRC', 'secret-environment'],
    ['config/.env.production', 'secret-environment'],
    ['Firefox/logins.json', 'os-or-browser-store'],
    ['FireFox/Profiles/abc/key4.db', 'os-or-browser-store'],
    ['sync/logins-backup.json', 'os-or-browser-store'],
    ['legacy/signons3.sqlite', 'os-or-browser-store'],
    ['.vercel/auth.json', 'provider-credential-store'],
    ['.netlify/credentials.json', 'provider-credential-store'],
    ['cli/.oci/config', 'provider-credential-store'],
    ['legacy/.gsutil/cred', 'provider-credential-store'],
    ['keys/id_ed25519_sk', 'key-material'],
  ] as const)('blocks additional secret-store fixtures %s as %s', (value, reason) => {
    expect(builtInExclusion(path(value))).toBe(reason)
  })

  it('matches a trailing-slash ignore rule against the directory itself', () => {
    const rules = parseIgnoreRules('generated/\n!.pd.log\n', 'gitignore')
    expect(exclusionForPath(path('generated'), [rules])).toBe('user-rule')
    expect(exclusionForPath(path('generated/artifacts.tmp'), [rules])).toBe('user-rule')
    expect(exclusionForPath(path('nested/generated'), [rules])).toBe('user-rule')
    expect(exclusionForPath(path('other'), [rules])).toBeNull()
  })

  it('keeps negated file rules effective without trailing-slash splitting', () => {
    const rules = parseIgnoreRules('!keep.md', 'cli')
    expect(exclusionForPath(path('keep.md'), [rules])).toBeNull()
  })

  it.each(['../escape', '/absolute', 'dir\\file', '!'])('rejects unsafe rule %s', (rule) => {
    expect(() => parseIgnoreRules(rule, 'cli')).toThrow(InvalidIgnoreRuleError)
  })
})

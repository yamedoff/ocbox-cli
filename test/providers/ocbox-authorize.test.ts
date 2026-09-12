import { describe, expect, it } from 'vitest'
import {
  authEndpointsFromIssuer,
  buildAuthorizationUrl,
  defaultBrowserAuthorizeEndpoint,
} from '../../src/auth/config.js'
import { resolveAuthEndpoints } from '../../src/auth/runtime.js'

describe('canonical browser authorization endpoint (T16)', () => {
  it('derives the consent page under the deployment base like the generated client', () => {
    expect(defaultBrowserAuthorizeEndpoint('https://api.example.test')).toBe(
      'https://api.example.test/v1/auth/cli/authorize',
    )
    expect(defaultBrowserAuthorizeEndpoint('https://api.example.test/deploy')).toBe(
      'https://api.example.test/deploy/v1/auth/cli/authorize',
    )
    expect(defaultBrowserAuthorizeEndpoint('https://api.example.test/v1/')).toBe(
      'https://api.example.test/v1/auth/cli/authorize',
    )
  })

  it('keeps an explicit cross-origin override while protocol endpoints stay bound', () => {
    const endpoints = authEndpointsFromIssuer('https://api.example.test', {
      authorizationEndpoint: 'https://login.example.test/authorize',
    })
    expect(endpoints.authorizationEndpoint).toBe('https://login.example.test/authorize')
    expect(endpoints.tokenEndpoint).toBe('https://api.example.test/v1/auth/cli/token')
  })

  it('resolves login without an explicit page and preserves subpaths', () => {
    const resolved = resolveAuthEndpoints({ 'api-url': 'https://api.example.test/deploy' }, {})
    expect(resolved.authorizationEndpoint).toBe(
      'https://api.example.test/deploy/v1/auth/cli/authorize',
    )
    const url = new URL(
      buildAuthorizationUrl(resolved, {
        codeChallenge: 'challenge-value',
        redirectUri: 'http://127.0.0.1:49152/callback',
        state: 'state-value-0123456789',
      }),
    )
    expect(url.pathname).toBe('/deploy/v1/auth/cli/authorize')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.has('code')).toBe(false)
  })
})

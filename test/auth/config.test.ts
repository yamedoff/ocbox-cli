import { describe, expect, it } from 'vitest'
import {
  authEndpointsFromIssuer,
  buildAuthorizationUrl,
  DEFAULT_CLIENT_ID,
  normalizeIssuer,
  protocolEndpointsFromIssuer,
} from '../../src/auth/config.js'

const BROWSER_PAGE = 'https://web.example.test/authorize'

describe('auth endpoint configuration', () => {
  it('derives the documented protocol endpoints from the issuer under the pinned /v1 contract root', () => {
    const endpoints = protocolEndpointsFromIssuer('https://api.example.test/')
    expect(endpoints.clientId).toBe(DEFAULT_CLIENT_ID)
    expect(endpoints.audience).toBe('cli')
    expect(endpoints.issuer).toBe('https://api.example.test')
    expect(endpoints.tokenEndpoint).toBe('https://api.example.test/v1/auth/cli/token')
    expect(endpoints.revocationEndpoint).toBe('https://api.example.test/v1/auth/revoke')
  })

  it('normalizes a caller-supplied trailing /v1 away like the generated client', () => {
    expect(protocolEndpointsFromIssuer('https://api.example.test/v1/').tokenEndpoint).toBe(
      'https://api.example.test/v1/auth/cli/token',
    )
    expect(protocolEndpointsFromIssuer('https://api.example.test/deploy/v1').tokenEndpoint).toBe(
      'https://api.example.test/deploy/v1/auth/cli/token',
    )
  })

  it('defaults the browser page to the canonical T16 consent surface preserving subpaths', () => {
    expect(authEndpointsFromIssuer('https://api.example.test').authorizationEndpoint).toBe(
      'https://api.example.test/v1/auth/cli/authorize',
    )
    expect(authEndpointsFromIssuer('https://api.example.test/deploy').authorizationEndpoint).toBe(
      'https://api.example.test/deploy/v1/auth/cli/authorize',
    )
    expect(authEndpointsFromIssuer('https://api.example.test/v1/').authorizationEndpoint).toBe(
      'https://api.example.test/v1/auth/cli/authorize',
    )
  })

  it('keeps an explicit cross-origin browser page while protocol endpoints stay on the API base', () => {
    const endpoints = authEndpointsFromIssuer('https://api.example.test', {
      authorizationEndpoint: BROWSER_PAGE,
    })
    expect(endpoints.authorizationEndpoint).toBe(BROWSER_PAGE)
    expect(endpoints.tokenEndpoint).toBe('https://api.example.test/v1/auth/cli/token')
  })

  it('rejects credentialed, relative, non-http, and query-bearing issuers', () => {
    expect(() => normalizeIssuer('not-a-url')).toThrow()
    expect(() => normalizeIssuer('ftp://example.test')).toThrow()
    expect(() => normalizeIssuer('https://user:pass@example.test')).toThrow()
    expect(() => normalizeIssuer('https://example.test/?x=1')).toThrow()
  })

  it('allows cleartext http only for loopback issuers and requires https elsewhere', () => {
    expect(normalizeIssuer('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(normalizeIssuer('http://localhost:3000')).toBe('http://localhost:3000')
    expect(() => normalizeIssuer('http://api.example.test')).toThrow(
      /must use https except on loopback/,
    )
    expect(() => normalizeIssuer('http://api.internal.example.test')).toThrow(
      /must use https except on loopback/,
    )
    expect(() => normalizeIssuer('http://192.168.1.10:9000')).toThrow(
      /must use https except on loopback/,
    )
    expect(() => normalizeIssuer('http://[::1]:9000')).not.toThrow()
  })

  it('builds a deterministic authorization URL with no code or verifier', () => {
    const endpoints = authEndpointsFromIssuer('https://api.example.test', {
      authorizationEndpoint: BROWSER_PAGE,
    })
    const url = new URL(
      buildAuthorizationUrl(endpoints, {
        codeChallenge: 'challenge-value',
        redirectUri: 'http://127.0.0.1:49152/callback',
        state: 'state-value',
      }),
    )
    expect(url.origin).toBe('https://web.example.test')
    expect(url.pathname).toBe('/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(DEFAULT_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:49152/callback')
    expect(url.searchParams.get('scope')).toBe('source:read')
    expect(url.searchParams.get('audience')).toBe('cli')
    expect(url.searchParams.get('state')).toBe('state-value')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.has('code')).toBe(false)
    expect(url.searchParams.has('code_verifier')).toBe(false)
    expect(url.searchParams.has('access_token')).toBe(false)
  })

  it('allows a separate browser authorization origin but binds token/revocation overrides to the issuer origin', () => {
    const endpoints = authEndpointsFromIssuer('https://api.example.test', {
      authorizationEndpoint: 'https://login.example.test/authorize',
    })
    expect(endpoints.authorizationEndpoint).toBe('https://login.example.test/authorize')
    expect(endpoints.tokenEndpoint).toBe('https://api.example.test/v1/auth/cli/token')
    expect(endpoints.revocationEndpoint).toBe('https://api.example.test/v1/auth/revoke')

    expect(() =>
      protocolEndpointsFromIssuer('https://api.example.test', {
        tokenEndpoint: 'https://evil.example.test/v1/auth/cli/token',
      }),
    ).toThrow(/configured hosted API base/)
    expect(() =>
      protocolEndpointsFromIssuer('https://api.example.test', {
        revocationEndpoint: 'https://evil.example.test/v1/auth/revoke',
      }),
    ).toThrow(/configured hosted API base/)
  })

  it('accepts same-origin token and revocation overrides', () => {
    const endpoints = protocolEndpointsFromIssuer('https://api.example.test', {
      revocationEndpoint: 'https://api.example.test/v1/custom/revoke',
      tokenEndpoint: 'https://api.example.test/v1/custom/token',
    })
    expect(endpoints.tokenEndpoint).toBe('https://api.example.test/v1/custom/token')
    expect(endpoints.revocationEndpoint).toBe('https://api.example.test/v1/custom/revoke')
  })

  it('rejects same-origin protocol overrides outside a configured deployment subpath', () => {
    expect(() =>
      protocolEndpointsFromIssuer('https://api.example.test/deploy', {
        tokenEndpoint: 'https://api.example.test/other/v1/auth/cli/token',
      }),
    ).toThrow(/configured hosted API base/)
  })

  it('rejects credentialed, relative, and query/fragment endpoint overrides', () => {
    expect(() =>
      protocolEndpointsFromIssuer('https://api.example.test', {
        tokenEndpoint: 'https://user:pass@api.example.test/v1/auth/cli/token',
      }),
    ).toThrow()
    expect(() =>
      protocolEndpointsFromIssuer('https://api.example.test', {
        tokenEndpoint: 'https://api.example.test/v1/auth/cli/token?x=1',
      }),
    ).toThrow()
    expect(() =>
      protocolEndpointsFromIssuer('https://api.example.test', {
        revocationEndpoint: '/auth/revoke',
      }),
    ).toThrow()
  })
})

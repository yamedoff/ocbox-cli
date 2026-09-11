import { describe, expect, it } from 'vitest'
import {
  authEndpointsFromIssuer,
  buildAuthorizationUrl,
  DEFAULT_CLIENT_ID,
  normalizeIssuer,
} from '../../src/auth/config.js'

describe('auth endpoint configuration', () => {
  it('derives the documented protocol endpoints from the issuer under the pinned /v1 contract root', () => {
    const endpoints = authEndpointsFromIssuer('https://api.example.test/')
    expect(endpoints.clientId).toBe(DEFAULT_CLIENT_ID)
    expect(endpoints.audience).toBe('cli')
    expect(endpoints.issuer).toBe('https://api.example.test')
    expect(endpoints.authorizationEndpoint).toBe('https://api.example.test/v1/auth/cli/authorize')
    expect(endpoints.tokenEndpoint).toBe('https://api.example.test/v1/auth/cli/token')
    expect(endpoints.revocationEndpoint).toBe('https://api.example.test/v1/auth/revoke')
  })

  it('normalizes a caller-supplied trailing /v1 away like the generated client', () => {
    expect(authEndpointsFromIssuer('https://api.example.test/v1/').tokenEndpoint).toBe(
      'https://api.example.test/v1/auth/cli/token',
    )
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
    const endpoints = authEndpointsFromIssuer('https://api.example.test')
    const url = new URL(
      buildAuthorizationUrl(endpoints, {
        codeChallenge: 'challenge-value',
        redirectUri: 'http://127.0.0.1:49152/callback',
        state: 'state-value',
      }),
    )
    expect(url.origin).toBe('https://api.example.test')
    expect(url.pathname).toBe('/v1/auth/cli/authorize')
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
})

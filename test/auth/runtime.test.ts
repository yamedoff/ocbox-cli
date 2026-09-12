import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveAuthEndpoints, resolveAuthStateDirectory } from '../../src/auth/runtime.js'
import { OcboxError } from '../../src/errors/index.js'

describe('auth runtime resolution', () => {
  it('fails login closed without an explicit browser authorization page', () => {
    let error: unknown = null
    try {
      resolveAuthEndpoints({ 'api-url': 'https://api.example.test' }, {})
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(OcboxError)
    expect((error as OcboxError).code).toBe('CONFIG_INVALID')
    expect((error as Error).message).toContain('browser authorization page')
  })

  it('keeps validator detail when the API base URL shape is rejected', () => {
    let error: unknown = null
    try {
      resolveAuthEndpoints(
        {
          'api-url': 'https://user:pass@api.example.test',
          'authorize-url': 'https://web.example.test/authorize',
        },
        {},
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(OcboxError)
    expect((error as OcboxError).code).toBe('CONFIG_INVALID')
    expect((error as Error).message).toContain('must not embed credentials')
  })

  it('resolves the login endpoints from flags and environment', () => {
    const endpoints = resolveAuthEndpoints(
      { 'api-url': 'https://api.example.test' },
      { OCBOX_AUTHORIZE_URL: 'https://web.example.test/authorize' },
    )
    expect(endpoints.issuer).toBe('https://api.example.test')
    expect(endpoints.authorizationEndpoint).toBe('https://web.example.test/authorize')
    expect(endpoints.tokenEndpoint).toBe('https://api.example.test/v1/auth/cli/token')
  })

  it('prefers an explicit state directory over flags and environment', () => {
    expect(resolveAuthStateDirectory({ stateDirectory: 'custom-dir' })).toBe(resolve('custom-dir'))
    expect(
      resolveAuthStateDirectory({
        environment: { OCBOX_STATE_DIR: 'env-dir' },
        flags: { 'state-dir': 'flag-dir' },
      }),
    ).toBe(resolve('flag-dir'))
    expect(resolveAuthStateDirectory({ environment: { OCBOX_STATE_DIR: 'env-dir' } })).toBe(
      resolve('env-dir'),
    )
  })
})

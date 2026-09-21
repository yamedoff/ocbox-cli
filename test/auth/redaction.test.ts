import { describe, expect, it } from 'vitest'
import { newRequestId } from '../../src/auth/errors.js'
import { AuthMetadataSchema } from '../../src/auth/metadata.js'
import { credentialFromTokenPair } from '../../src/auth/token-manager.js'
import { OcboxError } from '../../src/errors/index.js'
import { findSensitiveMaterial, REDACTED_VALUE, redactForOutput } from '../../src/security/index.js'
import { TEST_KEY, TEST_NOW, tokenPair } from './doubles.js'

describe('auth secret boundaries', () => {
  it('never accepts credential-like material or host paths in error messages', () => {
    expect(
      () =>
        new OcboxError({
          code: 'AUTH_REQUIRED',
          message: 'failed with Bearer abcdefghijklmnop',
          requestId: newRequestId(),
        }),
    ).toThrow()
    expect(
      () =>
        new OcboxError({
          code: 'AUTH_REQUIRED',
          message: 'failed reading C:\\Users\\secret\\creds.json',
          requestId: newRequestId(),
        }),
    ).toThrow()
  })

  it('finds no sensitive material in auth metadata', () => {
    const metadata = AuthMetadataSchema.parse({
      audience: 'cli',
      clientId: 'ocb_cli',
      expiresAt: new Date(TEST_NOW + 900_000).toISOString(),
      identity: TEST_KEY,
      issuer: 'https://api.example.test',
      schemaVersion: 1,
      scopes: ['source:read'],
      updatedAt: new Date(TEST_NOW).toISOString(),
    })
    expect(findSensitiveMaterial(metadata)).toEqual([])
  })

  it('recursively redacts token-shaped material in nested output', () => {
    const credential = credentialFromTokenPair(tokenPair('a'), TEST_NOW)
    const redacted = redactForOutput({
      nested: [{ accessToken: credential.accessToken, refreshToken: credential.refreshToken }],
      authorization: `Bearer ${credential.accessToken}`,
    })
    expect(JSON.stringify(redacted)).not.toContain(credential.accessToken)
    expect(JSON.stringify(redacted)).not.toContain(credential.refreshToken)
    expect(JSON.stringify(redacted)).toContain(REDACTED_VALUE)
  })
})

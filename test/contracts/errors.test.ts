import { describe, expect, it } from 'vitest'
import {
  OCBOX_ERROR_CODES,
  OCBOX_ERROR_REGISTRY,
  OcboxError,
  OcboxErrorCodeSchema,
  OcboxErrorDataSchema,
  RedactedDetailsSchema,
} from '../../src/contracts.js'
import { ids } from './test-data.js'

const exactCodes = [
  'AUTH_REQUIRED',
  'AUTH_EXPIRED',
  'AUTH_FORBIDDEN',
  'CONFIG_INVALID',
  'PROJECT_NOT_FOUND',
  'ENVIRONMENT_NOT_FOUND',
  'PROVIDER_AUTH',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_QUOTA',
  'PROVIDER_CAPACITY',
  'PROVIDER_REGION_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'INVALID_SPEC',
  'CAPABILITY_UNSUPPORTED',
  'SANDBOX_NOT_FOUND',
  'SANDBOX_NOT_READY',
  'INVALID_STATE',
  'OPERATION_CONFLICT',
  'OPERATION_TIMEOUT',
  'OPERATION_CANCELLED',
  'SYNC_CONFLICT',
  'SYNC_TOO_LARGE',
  'SYNC_INTEGRITY',
  'SYNC_FAILED',
  'NETWORK_POLICY_DENIED',
  'PREVIEW_UNAVAILABLE',
  'PAYMENT_REQUIRED',
  'INSUFFICIENT_CREDITS',
  'USAGE_LIMIT',
  'BILLING_RECONCILIATION',
  'INTERNAL',
] as const

describe('stable error contract', () => {
  it('exports exactly the 32 locked codes', () => {
    expect(OCBOX_ERROR_CODES).toEqual(exactCodes)
    expect(OCBOX_ERROR_CODES).toHaveLength(32)
    expect(new Set(OCBOX_ERROR_CODES)).toHaveLength(32)
    expect(Object.keys(OCBOX_ERROR_REGISTRY)).toEqual(exactCodes)
  })

  it('rejects codes outside the stable catalogue', () => {
    expect(OcboxErrorCodeSchema.safeParse('NO_ACTIVE_SANDBOX').success).toBe(false)
    expect(OcboxErrorCodeSchema.safeParse('USAGE').success).toBe(false)
  })

  it('locks retry classification to the registry', () => {
    for (const code of OCBOX_ERROR_CODES) {
      const valid = OcboxErrorDataSchema.safeParse({
        code,
        message: `Safe message for ${code}`,
        retryable: OCBOX_ERROR_REGISTRY[code].retryable,
        requestId: ids.request,
      })
      expect(valid.success, code).toBe(true)

      const invalid = OcboxErrorDataSchema.safeParse({
        code,
        message: `Safe message for ${code}`,
        retryable: !OCBOX_ERROR_REGISTRY[code].retryable,
        requestId: ids.request,
      })
      expect(invalid.success, code).toBe(false)
    }
  })

  it('serializes only the approved safe surface', () => {
    const error = new OcboxError({
      code: 'PROVIDER_RATE_LIMIT',
      message: 'Provider request was rate limited',
      requestId: ids.request,
      providerCode: 'HTTP_429',
      details: { retryAfterMilliseconds: 2_000 },
    })
    expect(error.toJSON()).toEqual({
      code: 'PROVIDER_RATE_LIMIT',
      message: 'Provider request was rate limited',
      retryable: true,
      requestId: ids.request,
      providerCode: 'HTTP_429',
      details: { retryAfterMilliseconds: 2_000 },
    })
    expect(Object.keys(error.toJSON()).sort()).toEqual([
      'code',
      'details',
      'message',
      'providerCode',
      'requestId',
      'retryable',
    ])
  })

  it.each([
    { localPath: 'C:\\Users\\example\\project' },
    { rawProviderError: 'provider stack' },
    { commandOutput: 'remote stdout' },
    { secretSuffix: '1234' },
    { preview: 'last four characters' },
    { recoverableMaterial: 'encrypted blob' },
    { nested: { credential: 'redacted-but-not-allowed' } },
    { note: 'sk-1234567890abcdef' },
    { note: 'Bearer abcdefghijklmnopqrstuvwxyz' },
  ])('rejects redaction canary details: %#', (details) => {
    expect(RedactedDetailsSchema.safeParse(details).success).toBe(false)
  })

  it('rejects unsafe message, raw cause and command-output fields', () => {
    expect(
      OcboxErrorDataSchema.safeParse({
        code: 'INTERNAL',
        message: 'Failure at C:\\Users\\example\\project',
        retryable: false,
        requestId: ids.request,
      }).success,
    ).toBe(false)
    expect(
      OcboxErrorDataSchema.safeParse({
        code: 'INTERNAL',
        message: 'Safe infrastructure failure',
        retryable: false,
        requestId: ids.request,
        cause: new Error('raw provider failure'),
      }).success,
    ).toBe(false)
    expect(
      OcboxErrorDataSchema.safeParse({
        code: 'PROVIDER_AUTH',
        message: 'Provider rejected authentication',
        retryable: false,
        requestId: ids.request,
        providerCode: 'sk-1234567890abcdef',
      }).success,
    ).toBe(false)
  })
})

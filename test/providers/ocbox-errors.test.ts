import { describe, expect, it } from 'vitest'
import { assertErrorRedacted } from '../../src/api/client/client.js'
import { mapApiFailureToOcboxError, toRequestId } from '../../src/api/client/errors.js'
import { OcboxError } from '../../src/errors/index.js'

const REQUEST_ID = '11111111-1111-4111-8111-111111111111'

describe('hosted error mapping', () => {
  it('maps auth failures to the stable catalogue and preserves request IDs', () => {
    expect(mapApiFailureToOcboxError({ requestId: REQUEST_ID, status: 401 }).code).toBe(
      'AUTH_REQUIRED',
    )
    expect(mapApiFailureToOcboxError({ requestId: REQUEST_ID, status: 401 }).requestId).toBe(
      REQUEST_ID,
    )
    expect(
      mapApiFailureToOcboxError({ requestId: REQUEST_ID, serverCode: 'INVALID_GRANT', status: 400 })
        .code,
    ).toBe('AUTH_REQUIRED')
    expect(mapApiFailureToOcboxError({ requestId: REQUEST_ID, status: 403 }).code).toBe(
      'AUTH_FORBIDDEN',
    )
  })

  it('maps rate, quota, payment, and provider failures distinctly', () => {
    expect(
      mapApiFailureToOcboxError({ requestId: REQUEST_ID, serverCode: 'RATE_LIMITED', status: 429 })
        .code,
    ).toBe('PROVIDER_RATE_LIMIT')
    expect(
      mapApiFailureToOcboxError({
        requestId: REQUEST_ID,
        serverCode: 'SERVICE_UNAVAILABLE',
        status: 503,
      }).code,
    ).toBe('PROVIDER_UNAVAILABLE')
    expect(
      mapApiFailureToOcboxError({
        requestId: REQUEST_ID,
        serverCode: 'QUOTA_EXCEEDED',
        status: 422,
      }).code,
    ).toBe('PROVIDER_QUOTA')
    expect(
      mapApiFailureToOcboxError({
        requestId: REQUEST_ID,
        serverCode: 'PAYMENT_REQUIRED',
        status: 402,
      }).code,
    ).toBe('PAYMENT_REQUIRED')
    expect(
      mapApiFailureToOcboxError({
        requestId: REQUEST_ID,
        serverCode: 'INSUFFICIENT_CREDITS',
        status: 402,
      }).code,
    ).toBe('INSUFFICIENT_CREDITS')
  })

  it('maps operation conflicts and source integrity without losing the server code', () => {
    const conflict = mapApiFailureToOcboxError({
      operation: 'startSession',
      requestId: REQUEST_ID,
      serverCode: 'SESSION_STATE_CONFLICT',
      status: 409,
    })
    expect(conflict.code).toBe('OPERATION_CONFLICT')
    expect(conflict.providerCode).toBe('SESSION_STATE_CONFLICT')
    const integrity = mapApiFailureToOcboxError({
      requestId: REQUEST_ID,
      serverCode: 'SOURCE_INTEGRITY_FAILED',
      status: 422,
    })
    expect(integrity.code).toBe('SYNC_INTEGRITY')
  })

  it('mints a local request ID when the server ID is not a public ID', () => {
    const mapped = mapApiFailureToOcboxError({ requestId: 'srv_123', status: 503 })
    expect(String(mapped.requestId)).not.toBe('srv_123')
    expect(String(toRequestId(REQUEST_ID))).toBe(REQUEST_ID)
  })

  it('keeps diagnostics free of credential-like material', () => {
    const error = new OcboxError({
      code: 'PROVIDER_RATE_LIMIT',
      message: 'The hosted service rate limit was reached',
      providerCode: 'RATE_LIMITED',
      requestId: REQUEST_ID as never,
    })
    expect(() => assertErrorRedacted(error)).not.toThrow()
    expect(JSON.stringify(error.toJSON())).not.toContain('Bearer')
  })
})

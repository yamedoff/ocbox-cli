import { describe, expect, it } from 'vitest'
import { assertErrorRedacted } from '../../src/api/client/client.js'
import { envelopeOf, mapApiFailureToOcboxError, toRequestId } from '../../src/api/client/errors.js'
import { OcboxError } from '../../src/errors/index.js'
import { seededApi } from './doubles.js'

const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const NEXT_STEP =
  'You have reached the number of running boxes for your plan; stop or destroy one (session_list) and retry.'

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

  it('carries the API next step and keeps a REST 404 code and message', () => {
    const envelope = envelopeOf({
      error: {
        code: 'NOT_FOUND',
        message: 'Resource was not found',
        nextStep: 'Run `ocbox project list` to find your project.',
      },
      requestId: REQUEST_ID,
    })
    expect(envelope).toEqual({
      code: 'NOT_FOUND',
      message: 'Resource was not found',
      nextStep: 'Run `ocbox project list` to find your project.',
      requestId: REQUEST_ID,
    })

    const mapped = mapApiFailureToOcboxError({
      requestId: envelope.requestId,
      serverCode: envelope.code,
      serverMessage: envelope.message,
      nextStep: envelope.nextStep,
      status: 404,
    })
    expect(mapped).toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      providerCode: 'NOT_FOUND',
      message: 'Resource was not found',
      details: { nextStep: 'Run `ocbox project list` to find your project.' },
    })
  })

  it('reads the safe provider reason from an error envelope', () => {
    const envelope = envelopeOf({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Box admission was refused',
        reason: 'user_active_limit',
      },
      requestId: REQUEST_ID,
    })
    expect(envelope.reason).toBe('user_active_limit')
    expect(envelope.code).toBe('SERVICE_UNAVAILABLE')
  })

  it('reads hosted limit metadata from an error envelope', () => {
    const envelope = envelopeOf({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Box admission was refused',
        reason: 'user_active_limit',
        reasonCode: 'user_active_limit',
        nextStep: NEXT_STEP,
        limitName: 'boxes_per_account',
        limitValue: 1,
      },
      requestId: REQUEST_ID,
    })
    expect(envelope.reason).toBe('user_active_limit')
    expect(envelope.reasonCode).toBe('user_active_limit')
    expect(envelope.nextStep).toBe(NEXT_STEP)
    expect(envelope.limitName).toBe('boxes_per_account')
    expect(envelope.limitValue).toBe(1)
  })

  it('keeps every refusal field the server supplied in error details', () => {
    const mapped = mapApiFailureToOcboxError({
      requestId: REQUEST_ID,
      serverCode: 'SERVICE_UNAVAILABLE',
      serverMessage: 'Box admission was refused',
      status: 503,
      reason: 'user_active_limit',
      reasonCode: 'user_active_limit',
      nextStep: NEXT_STEP,
      limitName: 'boxes_per_account',
      limitValue: 1,
    })
    expect(mapped.details).toEqual({
      reason: 'user_active_limit',
      reasonCode: 'user_active_limit',
      nextStep: NEXT_STEP,
      limitName: 'boxes_per_account',
      limitValue: 1,
    })
  })

  it('never invents refusal fields the server omitted', () => {
    const mapped = mapApiFailureToOcboxError({
      requestId: REQUEST_ID,
      serverCode: 'SERVICE_UNAVAILABLE',
      serverMessage: 'Box admission was refused',
      status: 503,
      reason: 'user_active_limit',
      reasonCode: 'user_active_limit',
      nextStep: NEXT_STEP,
    })
    expect(mapped.details).toEqual({
      reason: 'user_active_limit',
      reasonCode: 'user_active_limit',
      nextStep: NEXT_STEP,
    })
    expect(mapped.details).not.toHaveProperty('limitName')
    expect(mapped.details).not.toHaveProperty('limitValue')
    expect(mapped.message).toBe('Box admission was refused')
    expect(mapped.message).not.toContain('boxes_per_account')
    expect(mapped.message).not.toMatch(/\blimit\b/i)
  })

  it('passes a refused create envelope through the client boundary', async () => {
    const { api } = await seededApi(async () => new Response('{}', { status: 500 }))
    const body = {
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Box admission was refused',
        reason: 'user_active_limit',
        reasonCode: 'user_active_limit',
        nextStep: NEXT_STEP,
        limitName: 'boxes_per_account',
        limitValue: 1,
      },
      requestId: REQUEST_ID,
    }
    let caught: unknown
    try {
      api.assertSuccess(
        'createSession',
        { body, replay: false, requestId: REQUEST_ID, status: 503 },
        [200, 201, 202],
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OcboxError)
    const error = caught as OcboxError
    expect(error.details).toEqual({
      operation: 'createSession',
      reason: 'user_active_limit',
      reasonCode: 'user_active_limit',
      nextStep: NEXT_STEP,
      limitName: 'boxes_per_account',
      limitValue: 1,
    })
    expect(error.message).toContain('boxes_per_account')
    expect(error.message).toContain(`Next: ${NEXT_STEP}`)
  })

  it('drops malformed refusal fields instead of throwing', () => {
    const mapped = mapApiFailureToOcboxError({
      requestId: REQUEST_ID,
      serverCode: 'SERVICE_UNAVAILABLE',
      serverMessage: 'Box admission was refused',
      status: 503,
      reason: 'user_active_limit',
      reasonCode: 'NOT-A-CODE',
      limitName: '/etc/passwd',
      limitValue: 0,
    })
    expect(mapped.details).toEqual({ reason: 'user_active_limit' })
    expect(mapped.message).toBe('Box admission was refused')
  })

  it('drops a fractional limit value instead of throwing', () => {
    const mapped = mapApiFailureToOcboxError({
      requestId: REQUEST_ID,
      serverCode: 'SERVICE_UNAVAILABLE',
      serverMessage: 'Box admission was refused',
      status: 503,
      limitName: 'boxes_per_account',
      limitValue: 1.5,
    })
    expect(mapped.details).toEqual({ limitName: 'boxes_per_account' })
    expect(mapped.details).not.toHaveProperty('limitValue')
  })

  it('names the enforced limit and next step in the human message', () => {
    const mapped = mapApiFailureToOcboxError({
      requestId: REQUEST_ID,
      serverCode: 'SERVICE_UNAVAILABLE',
      serverMessage: 'Box admission was refused',
      status: 503,
      limitName: 'boxes_per_account',
      limitValue: 1,
      nextStep: NEXT_STEP,
    })
    expect(mapped.message).toContain('Box admission was refused')
    expect(mapped.message).toContain('boxes_per_account')
    expect(mapped.message).toMatch(/\b1\b/)
    expect(mapped.message).toContain(`Next: ${NEXT_STEP}`)
    expect(mapped.details).toEqual({
      nextStep: NEXT_STEP,
      limitName: 'boxes_per_account',
      limitValue: 1,
    })
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

import { describe, expect, it } from 'vitest'
import {
  CreateAdoptionPolicySchema,
  OperationContextSchema,
  OperationSchema,
  RequestContextSchema,
} from '../../src/contracts.js'
import { ids, timestamps } from './test-data.js'

const succeededPause = {
  id: ids.operation,
  requestId: ids.request,
  sessionId: ids.session,
  sandboxId: ids.sandbox,
  action: 'pause',
  status: 'succeeded',
  idempotencyKey: ids.idempotency,
  idempotencyResolution: { kind: 'created' },
  providerVerifiedAt: timestamps.completed,
  createdAt: timestamps.created,
  startedAt: timestamps.observed,
  completedAt: timestamps.completed,
} as const

describe('operation and idempotency contracts', () => {
  it('requires durable request and mutation context before provider calls', () => {
    expect(
      RequestContextSchema.parse({ requestId: ids.request, issuedAt: timestamps.created }),
    ).toEqual({ requestId: ids.request, issuedAt: timestamps.created })
    expect(
      OperationContextSchema.safeParse({
        requestId: ids.request,
        issuedAt: timestamps.created,
        operationId: ids.operation,
        idempotencyKey: ids.idempotency,
        attempt: 0,
      }).success,
    ).toBe(false)
  })

  it('retains create recovery metadata for both adoption strategies', () => {
    for (const strategy of ['metadata_search_then_adopt', 'serialize_then_reconcile'] as const) {
      expect(
        CreateAdoptionPolicySchema.parse({
          strategy,
          metadata: { sessionId: ids.session, operationId: ids.operation },
        }),
      ).toMatchObject({ strategy })
    }
  })

  it('accepts verified lifecycle success and an unresolved pending create', () => {
    expect(OperationSchema.parse(succeededPause)).toEqual(succeededPause)
    expect(
      OperationSchema.safeParse({
        ...succeededPause,
        sandboxId: null,
        action: 'create',
        status: 'pending',
        idempotencyResolution: null,
        providerVerifiedAt: null,
        startedAt: null,
        completedAt: null,
      }).success,
    ).toBe(true)
  })

  it('rejects missing sandbox identity, stale verification and premature outcomes', () => {
    expect(OperationSchema.safeParse({ ...succeededPause, sandboxId: null }).success).toBe(false)
    expect(
      OperationSchema.safeParse({
        ...succeededPause,
        providerVerifiedAt: timestamps.created,
      }).success,
    ).toBe(false)
    expect(
      OperationSchema.safeParse({
        ...succeededPause,
        status: 'running',
        idempotencyResolution: { kind: 'created' },
        providerVerifiedAt: null,
        completedAt: null,
      }).success,
    ).toBe(false)
    expect(
      OperationSchema.safeParse({
        ...succeededPause,
        action: 'exec',
        status: 'failed',
        idempotencyResolution: null,
        providerVerifiedAt: null,
        startedAt: null,
        completedAt: '2026-08-30T23:59:59.000Z',
      }).success,
    ).toBe(false)
  })
})

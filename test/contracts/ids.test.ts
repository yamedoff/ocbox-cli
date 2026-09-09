import { describe, expect, it } from 'vitest'
import {
  BindingIdSchema,
  ExecutionIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  ProviderSandboxIdSchema,
  RequestIdSchema,
  SandboxIdSchema,
  SessionIdSchema,
  UnixEpochMillisecondsSchema,
  UtcTimestampSchema,
} from '../../src/contracts.js'

const validUuid = '11111111-1111-4111-8111-111111111111'

describe('identity and timestamp primitives', () => {
  it.each([
    ProjectIdSchema,
    SessionIdSchema,
    SandboxIdSchema,
    BindingIdSchema,
    OperationIdSchema,
    ExecutionIdSchema,
    RequestIdSchema,
  ])('runtime-validates every internal branded ID schema', (schema) => {
    expect(schema.parse(validUuid)).toBe(validUuid)
    expect(schema.safeParse('incrementing-id-1').success).toBe(false)
    expect(schema.safeParse('00000000-0000-0000-0000-000000000000').success).toBe(false)
  })

  it('accepts ULIDs and keeps provider-native IDs opaque', () => {
    expect(SessionIdSchema.parse('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(ProviderSandboxIdSchema.parse('daytona/native:id/123')).toBe('daytona/native:id/123')
    expect(ProviderSandboxIdSchema.safeParse('provider id with spaces').success).toBe(false)
  })

  it('requires canonical UTC millisecond timestamps', () => {
    expect(UtcTimestampSchema.parse('2026-08-31T00:00:00.000Z')).toBe('2026-08-31T00:00:00.000Z')
    expect(UtcTimestampSchema.safeParse('2026-08-31T00:00:00Z').success).toBe(false)
    expect(UtcTimestampSchema.safeParse('2026-02-30T00:00:00.000Z').success).toBe(false)
    expect(UtcTimestampSchema.safeParse('2026-08-31T01:00:00.000+01:00').success).toBe(false)
    expect(UnixEpochMillisecondsSchema.safeParse(-1).success).toBe(false)
  })
})

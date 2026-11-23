import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  ProjectSchema,
  SessionSchema,
  type BindingId,
  type SandboxId,
  type SessionSandboxBinding,
  type SessionId,
} from '../../src/contracts.js'
import { ids, session, timestamps } from './test-data.js'

function internalId(index: number, kind: 'binding' | 'sandbox'): BindingId | SandboxId {
  const prefix = index.toString(16).padStart(8, kind === 'binding' ? 'a' : 'b')
  const value = `${prefix}-0000-4000-8000-000000000000`
  return value as BindingId | SandboxId
}

describe('Project and Session cardinality', () => {
  it('allows a Project to retain many distinct Sessions', () => {
    const project = ProjectSchema.parse({
      id: ids.project,
      name: 'Many sessions',
      sessionIds: [
        ids.session,
        '88888888-8888-4888-8888-888888888888' as SessionId,
        '99999999-9999-4999-8999-999999999999' as SessionId,
      ],
      createdAt: timestamps.created,
      updatedAt: timestamps.observed,
    })
    expect(project.sessionIds).toHaveLength(3)
  })

  it('rejects duplicate Project Session references', () => {
    expect(
      ProjectSchema.safeParse({
        id: ids.project,
        name: 'Duplicate',
        sessionIds: [ids.session, ids.session],
        createdAt: timestamps.created,
        updatedAt: timestamps.observed,
      }).success,
    ).toBe(false)
  })

  it('enforces one active primary binding and preserves ordered history', () => {
    const historical = {
      ...session.bindings[0],
      releasedAt: timestamps.observed,
    }
    const replacement = {
      ...session.bindings[0],
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as BindingId,
      sandboxId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as SandboxId,
      ordinal: 1,
      boundAt: timestamps.observed,
    }
    const parsed = SessionSchema.parse({ ...session, bindings: [historical, replacement] })
    expect(parsed.bindings).toHaveLength(2)
    expect(parsed.bindings[0]?.releasedAt).toBe(timestamps.observed)
    expect(parsed.bindings[1]?.releasedAt).toBeNull()
  })

  it('rejects multiple active bindings even when both are primary', () => {
    const second = {
      ...session.bindings[0],
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as BindingId,
      sandboxId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as SandboxId,
      ordinal: 1,
    }
    expect(
      SessionSchema.safeParse({ ...session, bindings: [...session.bindings, second] }).success,
    ).toBe(false)
  })

  it('rejects an active auxiliary binding in v0.1', () => {
    expect(
      SessionSchema.safeParse({
        ...session,
        bindings: [{ ...session.bindings[0], role: 'auxiliary' }],
      }).success,
    ).toBe(false)
  })

  it('permits zero bindings only during provisioning or verified deletion', () => {
    expect(SessionSchema.safeParse({ ...session, bindings: [] }).success).toBe(false)
    expect(
      SessionSchema.safeParse({
        ...session,
        state: 'creating',
        bindings: [],
        currentOperationId: ids.operation,
        providerVerifiedAt: null,
      }).success,
    ).toBe(true)
    expect(
      SessionSchema.safeParse({
        ...session,
        state: 'destroyed',
        bindings: [],
        providerVerifiedAt: timestamps.completed,
        sandboxDeletionVerifiedAt: timestamps.completed,
        updatedAt: timestamps.completed,
      }).success,
    ).toBe(true)
    expect(
      SessionSchema.safeParse({
        ...session,
        state: 'destroyed',
        bindings: [],
        sandboxDeletionVerifiedAt: null,
      }).success,
    ).toBe(false)
  })

  it('requires stable-state verification and rejects future binding evidence', () => {
    expect(SessionSchema.safeParse({ ...session, providerVerifiedAt: null }).success).toBe(false)
    expect(
      SessionSchema.safeParse({
        ...session,
        bindings: [{ ...session.bindings[0], boundAt: timestamps.completed }],
      }).success,
    ).toBe(false)
  })

  it('holds the cardinality invariant across arbitrary history lengths', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 8 }), (historyLength) => {
        const bindings: SessionSandboxBinding[] = Array.from(
          { length: historyLength },
          (_, index) => ({
            id: internalId(index + 1, 'binding') as BindingId,
            sessionId: ids.session,
            sandboxId: internalId(index + 1, 'sandbox') as SandboxId,
            role: 'primary' as const,
            ordinal: index,
            boundAt: timestamps.created,
            releasedAt: timestamps.observed,
          }),
        )
        bindings.push({
          id: internalId(historyLength + 20, 'binding') as BindingId,
          sessionId: ids.session,
          sandboxId: internalId(historyLength + 20, 'sandbox') as SandboxId,
          role: 'primary',
          ordinal: historyLength,
          boundAt: timestamps.observed,
          releasedAt: null,
        })

        expect(SessionSchema.safeParse({ ...session, bindings }).success).toBe(true)
      }),
    )
  })
})

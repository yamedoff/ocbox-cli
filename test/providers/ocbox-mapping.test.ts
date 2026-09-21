import { describe, expect, it } from 'vitest'
import { assertOwnedSession, resolvePrimaryBinding } from '../../src/providers/ocbox/mapping.js'
import { OcboxError } from '../../src/errors/index.js'
import { HOSTED_PROJECT, HOSTED_SANDBOX, HOSTED_SESSION, hostedSessionFixture } from './doubles.js'

describe('hosted primary binding mapping', () => {
  it('resolves the single active primary binding in ordinal order', () => {
    const session = hostedSessionFixture() as unknown as Parameters<typeof resolvePrimaryBinding>[0]
    const primary = resolvePrimaryBinding(session)
    expect(primary?.sandboxId).toBe(HOSTED_SANDBOX)
  })

  it('rejects multiple active bindings instead of silently ignoring them', () => {
    const session = hostedSessionFixture({
      sandboxes: [
        {
          active: true,
          boundAt: '2026-09-12T10:00:00.000Z',
          ordinal: 0,
          releasedAt: null,
          role: 'primary',
          sandboxId: 'sbx_a',
          state: 'running',
        },
        {
          active: true,
          boundAt: '2026-09-12T10:00:01.000Z',
          ordinal: 1,
          releasedAt: null,
          role: 'primary',
          sandboxId: 'sbx_b',
          state: 'running',
        },
      ],
    }) as unknown as Parameters<typeof resolvePrimaryBinding>[0]
    let error: unknown = null
    try {
      resolvePrimaryBinding(session)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(OcboxError)
    expect((error as OcboxError).code).toBe('INVALID_STATE')
    expect((error as OcboxError).providerCode).toBe('MULTIPLE_ACTIVE_PRIMARY_BINDINGS')
  })

  it('rejects a primary pointer that disagrees with the ordered bindings', () => {
    const session = hostedSessionFixture({
      primarySandboxId: 'sbx_other',
    }) as unknown as Parameters<typeof resolvePrimaryBinding>[0]
    expect(() => resolvePrimaryBinding(session)).toThrowError(OcboxError)
  })

  it('refuses sessions outside the owned project without trusting provider IDs', () => {
    const session = hostedSessionFixture({ projectId: 'proj_foreign' }) as unknown as Parameters<
      typeof assertOwnedSession
    >[0]
    expect(() => assertOwnedSession(session, HOSTED_PROJECT)).toThrowError(
      expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
    )
    expect(HOSTED_SESSION).toBe('sess_hosted_1')
  })
})

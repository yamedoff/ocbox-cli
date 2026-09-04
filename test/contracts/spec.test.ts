import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { RequestedEffectiveSpecSchema, SandboxSpecSchema } from '../../src/contracts.js'
import { effectiveSpec, requestedSpec, timestamps } from './test-data.js'

describe('Sandbox specification', () => {
  it('uses explicit CPU, RAM and disk units', () => {
    const parsed = SandboxSpecSchema.parse(requestedSpec)
    expect(parsed.cpu.millicores).toBe(1_000)
    expect(parsed.memory.bytes).toBe(1_073_741_824)
    expect(parsed.disk.bytes).toBe(10_737_418_240)
  })

  it('rejects impossible resources and lifecycle values', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 0 }), (millicores) => {
        expect(
          SandboxSpecSchema.safeParse({
            ...requestedSpec,
            cpu: { millicores },
          }).success,
        ).toBe(false)
      }),
    )

    expect(
      SandboxSpecSchema.safeParse({
        ...requestedSpec,
        lifecycle: {
          ...requestedSpec.lifecycle,
          autoStopAfterMilliseconds: 10_000,
          autoDestroyAfterMilliseconds: 5_000,
        },
      }).success,
    ).toBe(false)
    expect(
      SandboxSpecSchema.safeParse({
        ...requestedSpec,
        network: {
          ...requestedSpec.network,
          egress: 'restricted',
          allowedHosts: ['example.com:99999'],
        },
      }).success,
    ).toBe(false)
    expect(
      SandboxSpecSchema.safeParse({
        ...requestedSpec,
        source: {
          kind: 'git',
          repositoryUrl: 'https://github.com/example/repository.git?token=credential',
          revision: 'main',
          subdirectory: null,
        },
      }).success,
    ).toBe(false)
  })

  it('rejects impossible network policy and credential-bearing source URLs', () => {
    expect(
      SandboxSpecSchema.safeParse({
        ...requestedSpec,
        network: { ...requestedSpec.network, egress: 'restricted', allowedHosts: [] },
      }).success,
    ).toBe(false)
    expect(
      SandboxSpecSchema.safeParse({
        ...requestedSpec,
        source: {
          kind: 'git',
          repositoryUrl: 'https://user:credential@example.com/repository.git',
          revision: 'main',
          subdirectory: null,
        },
      }).success,
    ).toBe(false)
    expect(
      SandboxSpecSchema.safeParse({
        ...requestedSpec,
        source: {
          kind: 'git',
          repositoryUrl: 'https://github.com/example/repository.git',
          revision: 'main',
          subdirectory: 'packages/../private',
        },
      }).success,
    ).toBe(false)
  })

  it('has no field capable of carrying a secret value', () => {
    expect(
      SandboxSpecSchema.safeParse({
        ...requestedSpec,
        environment: {
          ...requestedSpec.environment,
          secretValue: 'not-allowed',
        },
      }).success,
    ).toBe(false)
  })

  it('does not fabricate an effective spec before provider observation', () => {
    const pending = RequestedEffectiveSpecSchema.parse({
      requested: requestedSpec,
      effective: null,
      effectiveObservedAt: null,
    })
    expect(pending.effective).toBeNull()

    expect(
      RequestedEffectiveSpecSchema.safeParse({
        requested: requestedSpec,
        effective: requestedSpec,
        effectiveObservedAt: null,
      }).success,
    ).toBe(false)
  })

  it('preserves requested/effective divergence after observation', () => {
    const observed = RequestedEffectiveSpecSchema.parse({
      requested: requestedSpec,
      effective: effectiveSpec,
      effectiveObservedAt: timestamps.observed,
    })
    expect(observed.requested.cpu.millicores).toBe(1_000)
    expect(observed.effective?.cpu.millicores).toBe(2_000)
    expect(observed.requested).not.toEqual(observed.effective)
  })
})

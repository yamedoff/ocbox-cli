import { describe, expect, it, vi } from 'vitest'
import {
  OcboxError,
  PRODUCT_MAX_SANDBOXES_PER_SESSION,
  ProviderCapabilitiesSchema,
  effectiveMaxSandboxesPerSession,
  runCapabilityGatedMutation,
  supportsCapability,
  type ProviderCapabilities,
} from '../../src/contracts.js'
import { ids } from './test-data.js'

const capabilities: ProviderCapabilities = {
  runtimeClasses: ['container'],
  lifecycle: {
    preservesFilesystemOnStop: true,
    supportsMemoryPause: false,
    supportsArchive: false,
  },
  execution: { streaming: true, cancellation: true },
  files: {
    read: true,
    write: true,
    list: true,
    stat: true,
    makeDirectory: true,
    remove: true,
    move: true,
    checksum: true,
  },
  previews: { supported: true, authenticated: true, http: true, websocket: true },
  egressModes: ['open', 'restricted', 'blocked'],
  metadataSearch: true,
  secretExposureModes: ['host_scoped_placeholder'],
  limits: {
    maxCpuMillicores: 8_000,
    maxMemoryBytes: 17_179_869_184,
    maxDiskBytes: 107_374_182_400,
    maxExecutionMilliseconds: 86_400_000,
    maxFileBytes: 1_073_741_824,
    maxConcurrentExecutions: 8,
    maxSandboxes: 100,
    maxSandboxesPerSession: 20,
  },
}

describe('provider capabilities', () => {
  it('validates the complete capability and limit surface', () => {
    expect(ProviderCapabilitiesSchema.parse(capabilities)).toEqual(capabilities)
  })

  it('keeps the effective product maximum at one regardless of provider limit', () => {
    expect(capabilities.limits.maxSandboxesPerSession).toBe(20)
    expect(effectiveMaxSandboxesPerSession(capabilities)).toBe(1)
    expect(PRODUCT_MAX_SANDBOXES_PER_SESSION).toBe(1)
  })

  it('requires explicit unsupported secret exposure to stand alone', () => {
    expect(
      ProviderCapabilitiesSchema.safeParse({
        ...capabilities,
        secretExposureModes: ['unsupported', 'process_environment'],
      }).success,
    ).toBe(false)
    expect(
      ProviderCapabilitiesSchema.safeParse({
        ...capabilities,
        secretExposureModes: ['unsupported'],
      }).success,
    ).toBe(true)
  })

  it('fails an unsupported capability before invoking a mutation', async () => {
    const mutation = vi.fn(async () => 'mutated')

    await expect(
      runCapabilityGatedMutation(capabilities, 'memory_pause', ids.request, mutation),
    ).rejects.toBeInstanceOf(OcboxError)
    expect(mutation).not.toHaveBeenCalled()
  })

  it('invokes a mutation only after a supported preflight', async () => {
    const mutation = vi.fn(async () => 'mutated')
    await expect(
      runCapabilityGatedMutation(capabilities, 'filesystem_stop', ids.request, mutation),
    ).resolves.toBe('mutated')
    expect(mutation).toHaveBeenCalledOnce()
  })

  it('does not treat an unauthenticated provider preview as product-compatible', () => {
    const unauthenticated = {
      ...capabilities,
      previews: { ...capabilities.previews, authenticated: false },
    }
    expect(supportsCapability(unauthenticated, 'preview')).toBe(true)
    expect(supportsCapability(unauthenticated, 'preview_authenticated')).toBe(false)
  })
})

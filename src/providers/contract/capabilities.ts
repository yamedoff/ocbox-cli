import { z } from 'zod'
import type { RequestId } from '../../domain/ids.js'
import { EgressModeSchema, ProviderRuntimeClassSchema } from '../../domain/spec.js'
import { OcboxError } from '../../errors/ocbox-error.js'

const OptionalPositiveLimitSchema = z.number().int().positive().safe().nullable()

export const ProviderLimitsSchema = z.strictObject({
  maxCpuMillicores: OptionalPositiveLimitSchema,
  maxMemoryBytes: OptionalPositiveLimitSchema,
  maxDiskBytes: OptionalPositiveLimitSchema,
  maxExecutionMilliseconds: OptionalPositiveLimitSchema,
  maxFileBytes: OptionalPositiveLimitSchema,
  maxConcurrentExecutions: OptionalPositiveLimitSchema,
  maxSandboxes: OptionalPositiveLimitSchema,
  maxSandboxesPerSession: z.number().int().positive().safe(),
})

export const SecretExposureModeSchema = z.enum([
  'host_scoped_placeholder',
  'process_environment',
  'unsupported',
])

export const ProviderCapabilitiesSchema = z
  .strictObject({
    runtimeClasses: z.array(ProviderRuntimeClassSchema).min(1).readonly(),
    lifecycle: z.strictObject({
      preservesFilesystemOnStop: z.boolean(),
      supportsMemoryPause: z.boolean(),
      supportsArchive: z.boolean(),
    }),
    execution: z.strictObject({
      streaming: z.boolean(),
      cancellation: z.boolean(),
    }),
    files: z.strictObject({
      read: z.boolean(),
      write: z.boolean(),
      list: z.boolean(),
      stat: z.boolean(),
      makeDirectory: z.boolean(),
      remove: z.boolean(),
      move: z.boolean(),
      checksum: z.boolean(),
    }),
    previews: z.strictObject({
      supported: z.boolean(),
      authenticated: z.boolean(),
      http: z.boolean(),
      websocket: z.boolean(),
    }),
    egressModes: z.array(EgressModeSchema).min(1).readonly(),
    metadataSearch: z.boolean(),
    secretExposureModes: z.array(SecretExposureModeSchema).min(1).readonly(),
    limits: ProviderLimitsSchema,
  })
  .superRefine((capabilities, context) => {
    const uniqueRuntimeClasses = new Set(capabilities.runtimeClasses)
    if (uniqueRuntimeClasses.size !== capabilities.runtimeClasses.length) {
      context.addIssue({ code: 'custom', message: 'Runtime classes must be unique' })
    }
    const uniqueEgress = new Set(capabilities.egressModes)
    if (uniqueEgress.size !== capabilities.egressModes.length) {
      context.addIssue({ code: 'custom', message: 'Egress modes must be unique' })
    }
    const uniqueSecretExposure = new Set(capabilities.secretExposureModes)
    if (uniqueSecretExposure.size !== capabilities.secretExposureModes.length) {
      context.addIssue({ code: 'custom', message: 'Secret exposure modes must be unique' })
    }
    if (
      capabilities.secretExposureModes.includes('unsupported') &&
      capabilities.secretExposureModes.length !== 1
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Unsupported secret exposure must be the only declared mode',
      })
    }
    if (
      !capabilities.previews.supported &&
      (capabilities.previews.authenticated ||
        capabilities.previews.http ||
        capabilities.previews.websocket)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Unsupported previews cannot declare preview features',
      })
    }
  })

export type ProviderLimits = z.infer<typeof ProviderLimitsSchema>
export type SecretExposureMode = z.infer<typeof SecretExposureModeSchema>
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>

/** Product policy is intentionally independent of a provider's higher limit. */
export const PRODUCT_MAX_SANDBOXES_PER_SESSION = 1 as const

export function effectiveMaxSandboxesPerSession(
  _capabilities: ProviderCapabilities,
): typeof PRODUCT_MAX_SANDBOXES_PER_SESSION {
  return PRODUCT_MAX_SANDBOXES_PER_SESSION
}

export const CAPABILITY_REQUIREMENTS = [
  'filesystem_stop',
  'memory_pause',
  'archive',
  'exec_streaming',
  'exec_cancel',
  'files_read',
  'files_write',
  'files_list',
  'files_stat',
  'files_make_directory',
  'files_remove',
  'files_move',
  'files_checksum',
  'preview',
  'preview_authenticated',
  'preview_http',
  'preview_websocket',
  'egress_open',
  'egress_restricted',
  'egress_blocked',
  'metadata_search',
  'secret_host_scoped_placeholder',
  'secret_process_environment',
] as const

export const CapabilityRequirementSchema = z.enum(CAPABILITY_REQUIREMENTS)
export type CapabilityRequirement = z.infer<typeof CapabilityRequirementSchema>

export function supportsCapability(
  capabilities: ProviderCapabilities,
  requirement: CapabilityRequirement,
): boolean {
  switch (requirement) {
    case 'filesystem_stop':
      return capabilities.lifecycle.preservesFilesystemOnStop
    case 'memory_pause':
      return capabilities.lifecycle.supportsMemoryPause
    case 'archive':
      return capabilities.lifecycle.supportsArchive
    case 'exec_streaming':
      return capabilities.execution.streaming
    case 'exec_cancel':
      return capabilities.execution.cancellation
    case 'files_read':
      return capabilities.files.read
    case 'files_write':
      return capabilities.files.write
    case 'files_list':
      return capabilities.files.list
    case 'files_stat':
      return capabilities.files.stat
    case 'files_make_directory':
      return capabilities.files.makeDirectory
    case 'files_remove':
      return capabilities.files.remove
    case 'files_move':
      return capabilities.files.move
    case 'files_checksum':
      return capabilities.files.checksum
    case 'preview':
      return capabilities.previews.supported
    case 'preview_authenticated':
      return capabilities.previews.supported && capabilities.previews.authenticated
    case 'preview_http':
      return capabilities.previews.supported && capabilities.previews.http
    case 'preview_websocket':
      return capabilities.previews.supported && capabilities.previews.websocket
    case 'egress_open':
      return capabilities.egressModes.includes('open')
    case 'egress_restricted':
      return capabilities.egressModes.includes('restricted')
    case 'egress_blocked':
      return capabilities.egressModes.includes('blocked')
    case 'metadata_search':
      return capabilities.metadataSearch
    case 'secret_host_scoped_placeholder':
      return capabilities.secretExposureModes.includes('host_scoped_placeholder')
    case 'secret_process_environment':
      return capabilities.secretExposureModes.includes('process_environment')
  }
}

export function assertCapabilitySupported(
  capabilities: ProviderCapabilities,
  requirement: CapabilityRequirement,
  requestId: RequestId,
): void {
  if (!supportsCapability(capabilities, requirement)) {
    throw new OcboxError({
      code: 'CAPABILITY_UNSUPPORTED',
      message: `Provider does not support capability ${requirement}`,
      requestId,
      details: { capability: requirement },
    })
  }
}

/**
 * Enforces the fail-before-mutation rule in one reusable boundary. The callback
 * is not evaluated when the capability is unsupported.
 */
export async function runCapabilityGatedMutation<Result>(
  capabilities: ProviderCapabilities,
  requirement: CapabilityRequirement,
  requestId: RequestId,
  mutation: () => Promise<Result>,
): Promise<Result> {
  assertCapabilitySupported(capabilities, requirement, requestId)
  return mutation()
}

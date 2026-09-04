import { z } from 'zod'
import { UtcTimestampSchema } from './timestamps.js'

const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
const HOST_PATTERN =
  /^(?:\*\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?::\d{1,5})?$/

const AllowedHostSchema = z
  .string()
  .regex(HOST_PATTERN)
  .refine((value) => {
    const port = value.match(/:(\d{1,5})$/)?.[1]
    return port === undefined || Number(port) <= 65_535
  }, 'Allowed-host port must be in the TCP port range')

export const CpuSpecSchema = z.strictObject({
  millicores: z.number().int().positive().safe(),
})

export const MemorySpecSchema = z.strictObject({
  bytes: z.number().int().positive().safe(),
})

export const DiskSpecSchema = z.strictObject({
  bytes: z.number().int().positive().safe(),
})

export const OperatingSystemSchema = z.enum(['linux', 'windows', 'macos'])
export const ArchitectureSchema = z.enum(['x86_64', 'arm64'])
export const ProviderRuntimeClassSchema = z.enum([
  'container',
  'microvm',
  'virtual_machine',
  'gpu',
  'unknown',
])

export const ImageReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('image'),
    reference: z.string().min(1).max(512).regex(SAFE_REFERENCE_PATTERN),
  }),
  z.strictObject({
    kind: z.literal('template'),
    reference: z.string().min(1).max(512).regex(SAFE_REFERENCE_PATTERN),
  }),
])

export const EGRESS_MODES = ['open', 'restricted', 'blocked'] as const
export const EgressModeSchema = z.enum(EGRESS_MODES)

export const NetworkSpecSchema = z
  .strictObject({
    egress: EgressModeSchema,
    allowedHosts: z.array(AllowedHostSchema).max(256).readonly(),
    directInbound: z.literal('blocked'),
    previews: z.literal('authenticated_only'),
  })
  .superRefine((network, context) => {
    const uniqueHosts = new Set(network.allowedHosts)
    if (uniqueHosts.size !== network.allowedHosts.length) {
      context.addIssue({ code: 'custom', message: 'Network allowed hosts must be unique' })
    }

    if (network.egress === 'restricted' && network.allowedHosts.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Restricted egress requires at least one allowed host',
      })
    }

    if (network.egress !== 'restricted' && network.allowedHosts.length !== 0) {
      context.addIssue({
        code: 'custom',
        message: 'Allowed hosts are valid only for restricted egress',
      })
    }
  })

export const LifecycleSpecSchema = z
  .strictObject({
    idleTimeoutMilliseconds: z.number().int().positive().safe().nullable(),
    maximumRuntimeMilliseconds: z.number().int().positive().safe().nullable(),
    autoStopAfterMilliseconds: z.number().int().positive().safe().nullable(),
    autoDestroyAfterMilliseconds: z.number().int().positive().safe().nullable(),
  })
  .superRefine((lifecycle, context) => {
    const { autoDestroyAfterMilliseconds, autoStopAfterMilliseconds, maximumRuntimeMilliseconds } =
      lifecycle

    if (
      autoDestroyAfterMilliseconds !== null &&
      autoStopAfterMilliseconds !== null &&
      autoDestroyAfterMilliseconds <= autoStopAfterMilliseconds
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Automatic destroy must occur after automatic stop',
      })
    }

    if (
      autoDestroyAfterMilliseconds !== null &&
      maximumRuntimeMilliseconds !== null &&
      autoDestroyAfterMilliseconds < maximumRuntimeMilliseconds
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Automatic destroy cannot precede maximum runtime',
      })
    }
  })

/**
 * References environment configuration without carrying a secret value (or a
 * reversible representation of one) through the sandbox specification.
 */
export const EnvironmentSpecSchema = z
  .strictObject({
    name: z.string().regex(REGION_PATTERN),
    variableNames: z.array(z.string().regex(ENVIRONMENT_NAME_PATTERN)).max(512).readonly(),
    secretReferenceIds: z
      .array(z.string().min(1).max(512).regex(SAFE_REFERENCE_PATTERN))
      .max(512)
      .readonly(),
  })
  .superRefine((environment, context) => {
    if (new Set(environment.variableNames).size !== environment.variableNames.length) {
      context.addIssue({ code: 'custom', message: 'Environment variable names must be unique' })
    }
    if (new Set(environment.secretReferenceIds).size !== environment.secretReferenceIds.length) {
      context.addIssue({ code: 'custom', message: 'Secret references must be unique' })
    }
  })

const GitRepositoryUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value)
    return (
      (url.protocol === 'https:' || url.protocol === 'ssh:') &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
    )
  }, 'Git source URL must use https or ssh and contain no credentials, query, or fragment')

const SourceSubdirectorySchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.split('/').some((segment) => segment === '..' || segment === '.' || segment === ''),
    'Source subdirectory must be a normalized relative path without traversal',
  )

export const SandboxSourceSpecSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('git'),
    repositoryUrl: GitRepositoryUrlSchema,
    revision: z.string().min(1).max(512).regex(SAFE_REFERENCE_PATTERN),
    subdirectory: SourceSubdirectorySchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('upload'),
    archiveFormat: z.enum(['tar', 'zip']),
    digest: z.strictObject({
      algorithm: z.literal('sha256'),
      value: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  }),
])

export const SandboxSpecSchema = z.strictObject({
  cpu: CpuSpecSchema,
  memory: MemorySpecSchema,
  disk: DiskSpecSchema,
  operatingSystem: OperatingSystemSchema,
  architecture: ArchitectureSchema,
  image: ImageReferenceSchema,
  region: z.string().regex(REGION_PATTERN),
  network: NetworkSpecSchema,
  lifecycle: LifecycleSpecSchema,
  environment: EnvironmentSpecSchema,
  source: SandboxSourceSpecSchema,
  providerClass: ProviderRuntimeClassSchema,
})

export const RequestedEffectiveSpecSchema = z
  .strictObject({
    requested: SandboxSpecSchema,
    effective: SandboxSpecSchema.nullable(),
    effectiveObservedAt: UtcTimestampSchema.nullable(),
  })
  .superRefine((specification, context) => {
    if ((specification.effective === null) !== (specification.effectiveObservedAt === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Effective specification and its observation timestamp must appear together',
      })
    }
  })

export type CpuSpec = z.infer<typeof CpuSpecSchema>
export type MemorySpec = z.infer<typeof MemorySpecSchema>
export type DiskSpec = z.infer<typeof DiskSpecSchema>
export type OperatingSystem = z.infer<typeof OperatingSystemSchema>
export type Architecture = z.infer<typeof ArchitectureSchema>
export type ProviderRuntimeClass = z.infer<typeof ProviderRuntimeClassSchema>
export type ImageReference = z.infer<typeof ImageReferenceSchema>
export type EgressMode = z.infer<typeof EgressModeSchema>
export type NetworkSpec = z.infer<typeof NetworkSpecSchema>
export type LifecycleSpec = z.infer<typeof LifecycleSpecSchema>
export type EnvironmentSpec = z.infer<typeof EnvironmentSpecSchema>
export type SandboxSourceSpec = z.infer<typeof SandboxSourceSpecSchema>
export type SandboxSpec = z.infer<typeof SandboxSpecSchema>
export type RequestedEffectiveSpec = z.infer<typeof RequestedEffectiveSpecSchema>

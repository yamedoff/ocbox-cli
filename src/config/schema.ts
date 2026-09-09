import { z } from 'zod'
import {
  ArchitectureSchema,
  EgressModeSchema,
  ImageReferenceSchema,
  OperatingSystemSchema,
  ProviderRuntimeClassSchema,
  SandboxSourceSpecSchema,
  SandboxSpecSchema,
  type SandboxSpec,
} from '../domain/spec.js'
import {
  findSensitiveMaterial,
  isProviderCredentialEnvironmentName,
} from '../security/redaction.js'

export const CURRENT_CONFIG_SCHEMA_VERSION = 1 as const

const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/
const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const HOST_PATTERN =
  /^(?:\*\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?::\d{1,5})?$/

const AllowedHostSchema = z
  .string()
  .regex(HOST_PATTERN)
  .refine((value) => {
    const port = value.match(/:(\d{1,5})$/)?.[1]
    return port === undefined || Number(port) <= 65_535
  }, 'Allowed-host port must be in the TCP port range')

export const ProviderConfigSchema = z.strictObject({
  name: z.string().regex(PROVIDER_NAME_PATTERN),
  runtimeClass: ProviderRuntimeClassSchema,
  region: z.string().regex(REGION_PATTERN),
})

export const ResourceConfigSchema = z.strictObject({
  cpuMillicores: z.number().int().positive().safe(),
  memoryBytes: z.number().int().positive().safe(),
  diskBytes: z.number().int().positive().safe(),
})

export const SandboxConfigSchema = z.strictObject({
  operatingSystem: OperatingSystemSchema,
  architecture: ArchitectureSchema,
  image: ImageReferenceSchema,
  environmentName: z.string().regex(REGION_PATTERN).default('development'),
  resources: ResourceConfigSchema,
})

export const NetworkConfigSchema = z
  .strictObject({
    egress: EgressModeSchema,
    allowedHosts: z.array(AllowedHostSchema).max(256).default([]),
    directInbound: z.literal('blocked').default('blocked'),
    previews: z.literal('authenticated_only').default('authenticated_only'),
  })
  .superRefine((network, context) => {
    if (new Set(network.allowedHosts).size !== network.allowedHosts.length) {
      context.addIssue({
        code: 'custom',
        path: ['allowedHosts'],
        message: 'Allowed hosts must be unique',
      })
    }
    if (network.egress === 'restricted' && network.allowedHosts.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['allowedHosts'],
        message: 'Restricted egress requires at least one allowed host',
      })
    }
    if (network.egress !== 'restricted' && network.allowedHosts.length !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['allowedHosts'],
        message: 'Allowed hosts are valid only for restricted egress',
      })
    }
  })

const OptionalTimeoutSchema = z.number().int().positive().safe().nullable().optional()

export const LifecycleConfigSchema = z
  .strictObject({
    idleTimeoutMilliseconds: OptionalTimeoutSchema,
    maximumRuntimeMilliseconds: OptionalTimeoutSchema,
    autoStopAfterMilliseconds: OptionalTimeoutSchema,
    autoDestroyAfterMilliseconds: OptionalTimeoutSchema,
  })
  .superRefine((lifecycle, context) => {
    const autoStop = lifecycle.autoStopAfterMilliseconds ?? null
    const autoDestroy = lifecycle.autoDestroyAfterMilliseconds ?? null
    const maximumRuntime = lifecycle.maximumRuntimeMilliseconds ?? null
    if (autoDestroy !== null && autoStop !== null && autoDestroy <= autoStop) {
      context.addIssue({
        code: 'custom',
        path: ['autoDestroyAfterMilliseconds'],
        message: 'Automatic destroy must occur after automatic stop',
      })
    }
    if (autoDestroy !== null && maximumRuntime !== null && autoDestroy < maximumRuntime) {
      context.addIssue({
        code: 'custom',
        path: ['autoDestroyAfterMilliseconds'],
        message: 'Automatic destroy cannot precede maximum runtime',
      })
    }
  })

export const NonSecretEnvironmentSchema = z
  .record(
    z.string().regex(ENVIRONMENT_NAME_PATTERN),
    z
      .string()
      .max(4_096)
      .refine(
        (value) =>
          !findSensitiveMaterial(value).some(
            (finding) => finding.kind === 'credential-value' || finding.kind === 'local-path',
          ),
        'Environment values must be non-secret and cannot contain host-local paths',
      ),
  )
  .superRefine((environment, context) => {
    for (const name of Object.keys(environment)) {
      if (isProviderCredentialEnvironmentName(name)) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: 'Provider credential variables are environment-only and cannot be configured',
        })
      }
    }
  })

/** Canonical, versioned project configuration stored in `opencloudbox.toml`. */
export const ProjectConfigSchema = z.strictObject({
  schemaVersion: z.literal(CURRENT_CONFIG_SCHEMA_VERSION),
  provider: ProviderConfigSchema,
  sandbox: SandboxConfigSchema,
  network: NetworkConfigSchema,
  lifecycle: LifecycleConfigSchema,
  source: SandboxSourceSpecSchema,
  env: NonSecretEnvironmentSchema.default({}),
})

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>

/** Maps the canonical file shape to the T2 provider-neutral Sandbox contract. */
export function toSandboxSpec(config: ProjectConfig): SandboxSpec {
  return SandboxSpecSchema.parse({
    cpu: { millicores: config.sandbox.resources.cpuMillicores },
    memory: { bytes: config.sandbox.resources.memoryBytes },
    disk: { bytes: config.sandbox.resources.diskBytes },
    operatingSystem: config.sandbox.operatingSystem,
    architecture: config.sandbox.architecture,
    image: config.sandbox.image,
    region: config.provider.region,
    network: config.network,
    lifecycle: {
      idleTimeoutMilliseconds: config.lifecycle.idleTimeoutMilliseconds ?? null,
      maximumRuntimeMilliseconds: config.lifecycle.maximumRuntimeMilliseconds ?? null,
      autoStopAfterMilliseconds: config.lifecycle.autoStopAfterMilliseconds ?? null,
      autoDestroyAfterMilliseconds: config.lifecycle.autoDestroyAfterMilliseconds ?? null,
    },
    environment: {
      name: config.sandbox.environmentName,
      variableNames: Object.keys(config.env).sort(),
      secretReferenceIds: [],
    },
    source: config.source,
    providerClass: config.provider.runtimeClass,
  })
}

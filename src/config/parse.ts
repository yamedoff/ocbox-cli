import { parse, stringify } from 'smol-toml'
import { findSensitiveMaterial, type SensitiveMaterialFinding } from '../security/redaction.js'
import {
  ConfigValidationError,
  type ConfigDiagnostic,
  zodIssuesToDiagnostics,
} from './diagnostics.js'
import { CURRENT_CONFIG_SCHEMA_VERSION, ProjectConfigSchema, type ProjectConfig } from './schema.js'

const MAX_CONFIG_BYTES = 1_048_576

const DEPRECATED_FIELDS: Readonly<Record<string, string>> = {
  resources: 'sandbox.resources',
  version: 'schemaVersion',
  'provider.type': 'provider.name',
  'provider.class': 'provider.runtimeClass',
  'resources.cpu': 'resources.cpuMillicores',
  'resources.memory': 'resources.memoryBytes',
  'resources.disk': 'resources.diskBytes',
  environment: 'env',
  'network.allow': 'network.allowedHosts',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasPath(value: unknown, path: string): boolean {
  let current: unknown = value
  for (const segment of path.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return false
    current = current[segment]
  }
  return true
}

function deprecatedDiagnostics(document: unknown): ConfigDiagnostic[] {
  return Object.entries(DEPRECATED_FIELDS)
    .filter(([path]) => hasPath(document, path))
    .map(([path, replacement]) => ({
      code: 'deprecated_field' as const,
      path,
      replacement,
      message: `Deprecated configuration field ${path}; use ${replacement}`,
    }))
}

function parseTomlDocument(source: string): Record<string, unknown> {
  if (Buffer.byteLength(source, 'utf8') > MAX_CONFIG_BYTES) {
    throw new ConfigValidationError([
      {
        code: 'invalid_syntax',
        path: '<document>',
        message: 'Configuration exceeds the 1 MiB safety limit',
      },
    ])
  }

  try {
    const parsed: unknown = parse(source)
    if (!isRecord(parsed)) throw new TypeError('TOML root is not a table')
    return parsed
  } catch (error) {
    if (error instanceof ConfigValidationError) throw error
    const rawMessage = error instanceof Error ? error.message : ''
    const location = rawMessage.match(/(?:line|row)\s*(\d+).*?(?:column|col)\s*(\d+)/i)
    const suffix = location === null ? '' : ` near line ${location[1]}, column ${location[2]}`
    throw new ConfigValidationError([
      {
        code: 'invalid_syntax',
        path: '<document>',
        message: `Invalid TOML syntax${suffix}`,
      },
    ])
  }
}

/** Parses and validates a canonical `opencloudbox.toml` document. */
export function parseProjectConfig(source: string): ProjectConfig {
  const document = parseTomlDocument(source)
  const deprecated = deprecatedDiagnostics(document)
  if (deprecated.length > 0) throw new ConfigValidationError(deprecated)

  const result = ProjectConfigSchema.safeParse(document)
  if (!result.success) throw new ConfigValidationError(zodIssuesToDiagnostics(result.error.issues))
  return result.data
}

function isCredentialFinding(finding: SensitiveMaterialFinding): boolean {
  return (
    finding.kind === 'credential-field' ||
    finding.kind === 'credential-value' ||
    finding.kind === 'provider-byok'
  )
}

/**
 * The only v0 migration adds the explicit schema marker. It refuses any
 * credential-looking input before serialization and never renames or copies a
 * value into a field with different semantics.
 */
export function migrateProjectConfig(source: string): string {
  const document = parseTomlDocument(source)
  const version = document['schemaVersion']
  if (version === CURRENT_CONFIG_SCHEMA_VERSION) return source
  if (version !== undefined && version !== 0) {
    throw new ConfigValidationError([
      {
        code: 'unsupported_version',
        path: 'schemaVersion',
        message: 'Unsupported configuration schema version; expected schemaVersion = 1',
      },
    ])
  }

  const unsafe = findSensitiveMaterial(document).filter(isCredentialFinding)
  if (unsafe.length > 0) {
    throw new ConfigValidationError(
      unsafe.map((finding) => ({
        code: 'migration_refused' as const,
        path: finding.path.join('.') || '<root>',
        message: `Migration refused credential-looking material at ${finding.path.join('.') || '<root>'}`,
      })),
    )
  }

  const migrated = { ...document, schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION }
  const canonical = stringify(migrated)
  parseProjectConfig(canonical)
  return canonical
}

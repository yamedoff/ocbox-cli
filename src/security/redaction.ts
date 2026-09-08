/** JSON values accepted by output, logging, and telemetry boundaries. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export const REDACTED_VALUE = '[REDACTED]'
export const REDACTED_LOCAL_PATH = '[LOCAL_PATH]'

const SENSITIVE_KEY =
  /(?:secret|credential|password|passphrase|token|authorization|cookie|api[_-]?key|private[_-]?key)/i
const COMMAND_OUTPUT_KEY =
  /^(?:command|argv|stdout|stderr|command[_-]?output|raw[_-]?output|source[_-]?content)$/i
const PROVIDER_BYOK_NAME =
  /(?:^|_)(?:API_KEY|ACCESS_KEY|SECRET_KEY|TOKEN|PASSWORD|CREDENTIALS?)(?:$|_)/i
const SECRET_VALUE =
  /(?:-----BEGIN [A-Z ]+PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{8,}|\bAKIA[A-Z0-9]{12,}|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*|(?:(?:proxy-)?authorization|(?:set-)?cookie|password|token|secret|api[_-]?key)\s*[:=]\s*\S+|[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@)/i
const LOCAL_PATH =
  /(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/](?:[^\s"']+)|\\\\[^\\\s]+\\[^\s"']+|(?:^|[\s"'(=])\/(?!\/)[^\s"']+)/i
const LOCAL_PATH_GLOBAL =
  /(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/](?:[^\s"']+)|\\\\[^\\\s]+\\[^\s"']+|(?:^|[\s"'(=])\/(?!\/)[^\s"']+)/gi

export type SensitiveMaterialKind =
  | 'command-output'
  | 'credential-field'
  | 'credential-value'
  | 'local-path'
  | 'provider-byok'

export interface SensitiveMaterialFinding {
  readonly kind: SensitiveMaterialKind
  readonly path: readonly (string | number)[]
}

function normalizedKey(key: string): string {
  return key.replaceAll(/[^A-Za-z0-9_-]/g, '_')
}

/** True when an environment variable name conventionally carries provider credentials. */
export function isProviderCredentialEnvironmentName(name: string): boolean {
  return PROVIDER_BYOK_NAME.test(name) || SENSITIVE_KEY.test(normalizedKey(name))
}

/**
 * Finds material that must not cross persistence or telemetry boundaries.
 * Findings contain schema paths only; the sensitive values are never copied.
 */
export function findSensitiveMaterial(
  value: unknown,
  path: readonly (string | number)[] = [],
  seen: ReadonlySet<object> = new Set<object>(),
): readonly SensitiveMaterialFinding[] {
  if (typeof value === 'string') {
    const findings: SensitiveMaterialFinding[] = []
    if (SECRET_VALUE.test(value)) findings.push({ kind: 'credential-value', path })
    if (LOCAL_PATH.test(value)) findings.push({ kind: 'local-path', path })
    return findings
  }
  if (value === null || typeof value !== 'object') return []
  if (seen.has(value)) return []

  const nextSeen = new Set(seen)
  nextSeen.add(value)
  const findings: SensitiveMaterialFinding[] = []

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      findings.push(...findSensitiveMaterial(item, [...path, index], nextSeen))
    }
    return findings
  }

  for (const [key, item] of Object.entries(value)) {
    const itemPath = [...path, key]
    if (COMMAND_OUTPUT_KEY.test(key)) findings.push({ kind: 'command-output', path: itemPath })
    if (SENSITIVE_KEY.test(normalizedKey(key))) {
      findings.push({ kind: 'credential-field', path: itemPath })
    }
    if (isProviderCredentialEnvironmentName(key)) {
      findings.push({ kind: 'provider-byok', path: itemPath })
    }
    findings.push(...findSensitiveMaterial(item, itemPath, nextSeen))
  }
  return findings
}

/**
 * Recursively converts arbitrary values into safe JSON. Credential fields,
 * command output, token-shaped strings, and host-local paths are redacted.
 */
export function redactForOutput(value: unknown, seen: ReadonlySet<object> = new Set()): JsonValue {
  if (value === null) return null
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) return REDACTED_VALUE
    return value.replace(LOCAL_PATH_GLOBAL, REDACTED_LOCAL_PATH)
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return null
  }
  if (seen.has(value)) return '[CIRCULAR]'

  const nextSeen = new Set(seen)
  nextSeen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactForOutput(item, nextSeen))
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactForOutput(value.message, nextSeen),
    }
  }

  const output: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value)) {
    if (COMMAND_OUTPUT_KEY.test(key) || SENSITIVE_KEY.test(normalizedKey(key))) {
      output[key] = REDACTED_VALUE
    } else {
      output[key] = redactForOutput(item, nextSeen)
    }
  }
  return output
}

const TELEMETRY_FIELDS = new Set([
  'schemaVersion',
  'event',
  'provider',
  'code',
  'success',
  'retryable',
  'requestId',
  'operationId',
  'sessionId',
  'sandboxId',
  'executionId',
  'durationMilliseconds',
  'count',
  'bytes',
  'clientVersion',
])

/**
 * Telemetry is a flat allowlist, not a copy of user-visible output. Arbitrary
 * objects, names, commands and environment/source metadata are never captured.
 */
export function sanitizeTelemetryPayload(value: unknown): JsonValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, item]) =>
        TELEMETRY_FIELDS.has(key) &&
        (typeof item === 'boolean' ||
          (typeof item === 'number' && Number.isFinite(item)) ||
          (typeof item === 'string' &&
            item.length <= 128 &&
            /^[A-Za-z0-9._:-]+$/.test(item) &&
            !SECRET_VALUE.test(item))),
    ),
  ) as JsonValue
}

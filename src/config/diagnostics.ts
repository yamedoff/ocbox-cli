import type { z } from 'zod'
import { redactForOutput } from '../security/redaction.js'

export type ConfigDiagnosticCode =
  | 'deprecated_field'
  | 'invalid_syntax'
  | 'invalid_value'
  | 'migration_refused'
  | 'unsupported_version'
  | 'unknown_field'

export interface ConfigDiagnostic {
  readonly code: ConfigDiagnosticCode
  readonly path: string
  readonly message: string
  readonly replacement?: string
}

/** Safe configuration failure whose messages contain schema paths, never values. */
export class ConfigValidationError extends Error {
  readonly diagnostics: readonly ConfigDiagnostic[]

  constructor(diagnostics: readonly ConfigDiagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join('; '))
    this.name = 'ConfigValidationError'
    this.diagnostics = diagnostics
  }
}

function joinPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '<root>'
  return path
    .map((segment, index) =>
      typeof segment === 'number'
        ? `[${segment}]`
        : `${index > 0 ? '.' : ''}${String(redactForOutput(String(segment))).replaceAll(/[\r\n\u001b]/g, '')}`,
    )
    .join('')
}

const KNOWN_CHILDREN: Readonly<Record<string, readonly string[]>> = {
  '<root>': ['schemaVersion', 'provider', 'sandbox', 'network', 'lifecycle', 'source', 'env'],
  provider: ['name', 'runtimeClass', 'region'],
  sandbox: ['operatingSystem', 'architecture', 'image', 'environmentName', 'resources'],
  'sandbox.image': ['kind', 'reference'],
  'sandbox.resources': ['cpuMillicores', 'memoryBytes', 'diskBytes'],
  network: ['egress', 'allowedHosts', 'directInbound', 'previews'],
  lifecycle: [
    'idleTimeoutMilliseconds',
    'maximumRuntimeMilliseconds',
    'autoStopAfterMilliseconds',
    'autoDestroyAfterMilliseconds',
  ],
  source: ['kind', 'repositoryUrl', 'revision', 'subdirectory', 'archiveFormat', 'digest'],
  'source.digest': ['algorithm', 'value'],
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = row[0] ?? 0
    row[0] = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const previous = row[rightIndex] ?? 0
      row[rightIndex] = Math.min(
        (row[rightIndex] ?? 0) + 1,
        (row[rightIndex - 1] ?? 0) + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      )
      diagonal = previous
    }
  }
  return row[right.length] ?? Number.POSITIVE_INFINITY
}

function suggest(parent: string, key: string): string | undefined {
  const candidates = KNOWN_CHILDREN[parent] ?? []
  const ranked = candidates
    .map((candidate) => ({ candidate, distance: editDistance(key, candidate) }))
    .sort((left, right) => left.distance - right.distance)
  const best = ranked[0]
  return best !== undefined && best.distance <= Math.max(2, Math.floor(key.length / 3))
    ? best.candidate
    : undefined
}

export function zodIssuesToDiagnostics(issues: readonly z.core.$ZodIssue[]): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = []
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      const parent = joinPath(issue.path)
      for (const key of issue.keys) {
        const safeKey = joinPath([key])
        const path = parent === '<root>' ? safeKey : `${parent}.${safeKey}`
        const suggestedKey = suggest(parent, key)
        const replacement =
          suggestedKey === undefined
            ? undefined
            : parent === '<root>'
              ? suggestedKey
              : `${parent}.${suggestedKey}`
        diagnostics.push({
          code: 'unknown_field',
          path,
          message:
            replacement === undefined
              ? `Unknown configuration field ${path}`
              : `Unknown configuration field ${path}; did you mean ${replacement}?`,
          ...(replacement === undefined ? {} : { replacement }),
        })
      }
      continue
    }

    const path = joinPath(issue.path)
    diagnostics.push({
      code: 'invalid_value',
      path,
      message: `Invalid configuration value at ${path}: ${issue.message}`,
    })
  }
  return diagnostics
}

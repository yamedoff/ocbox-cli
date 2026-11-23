import { parse, stringify } from 'smol-toml'
import { isRecord } from './document.js'
import { CodexAdapterError } from './errors.js'

const MAX_DOCUMENT_BYTES = 4_194_304

function tooLarge(source: string): boolean {
  return Buffer.byteLength(source, 'utf8') > MAX_DOCUMENT_BYTES
}

export function parseTomlDocument(
  source: string | null,
  label = 'config.toml',
): Record<string, unknown> | null {
  if (source === null) return null
  if (tooLarge(source)) {
    throw new CodexAdapterError({
      code: 'CODEX_CONFIG_INVALID',
      message: `${label} exceeds the adapter safety limit`,
      remediation: 'Reduce the size of the Codex configuration before running the adapter.',
    })
  }
  try {
    const parsed: unknown = parse(source)
    if (!isRecord(parsed)) throw new TypeError('TOML root is not a table')
    return parsed
  } catch (error) {
    if (error instanceof CodexAdapterError) throw error
    throw new CodexAdapterError({
      code: 'CODEX_CONFIG_INVALID',
      message: `${label} is not valid TOML`,
      remediation: `Repair ${label} or move it aside; the adapter will not rewrite unparseable TOML.`,
    })
  }
}

export function serializeTomlDocument(document: Record<string, unknown>): string {
  if (Object.keys(document).length === 0) return ''
  return stringify(document)
}

export function parseHooksJsonDocument(
  source: string | null,
  label = 'hooks.json',
): Record<string, unknown> | null {
  if (source === null || source.trim().length === 0) return null
  if (tooLarge(source)) {
    throw new CodexAdapterError({
      code: 'CODEX_HOOKS_INVALID',
      message: `${label} exceeds the adapter safety limit`,
      remediation: 'Reduce the size of the Codex hooks file before running the adapter.',
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new CodexAdapterError({
      code: 'CODEX_HOOKS_INVALID',
      message: `${label} is not valid JSON`,
      remediation: `Repair or remove ${label}; the adapter will not rewrite unparseable JSON.`,
    })
  }
  if (!isRecord(parsed)) {
    throw new CodexAdapterError({
      code: 'CODEX_HOOKS_INVALID',
      message: `${label} must contain a JSON object`,
      remediation: `Replace ${label} with a JSON object before running the adapter.`,
    })
  }
  return parsed
}

export function serializeHooksJsonDocument(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

export class CodexTomlError extends Error {
  readonly code = 'TOML_PARSE_ERROR' as const
  constructor(message: string) {
    super(message)
    this.name = 'CodexTomlError'
  }
}

export function parseCodexToml(text: string): Record<string, unknown> {
  try {
    const document = parseTomlDocument(text)
    if (document === null) throw new CodexTomlError('Codex config is empty; refusing to merge.')
    return document
  } catch (error) {
    if (error instanceof CodexTomlError) throw error
    throw new CodexTomlError('Codex config is not parseable TOML; refusing to merge.')
  }
}

export function serializeCodexToml(document: Record<string, unknown>): string {
  const serialized = serializeTomlDocument(document)
  return serialized.length === 0 ? '' : `${serialized.trimEnd()}\n`
}

import { isRecord } from './document.js'
import { CodexAdapterError } from './errors.js'
import { CODEX_HOOK_EVENTS, CODEX_HOOKS_TABLE_KEY } from './hooks.js'
import {
  assertSupportedCodexVersion,
  type CodexSchemaDescriptor,
  codexSchemaDescriptor,
  parseCodexVersion,
} from './version.js'

const KNOWN_EVENTS = new Set<string>(CODEX_HOOK_EVENTS)

export interface ParsedCodexDocuments {
  readonly config: Record<string, unknown> | null
  readonly hooks: Record<string, unknown> | null
}

export function validateHooksTable(value: unknown, source: string): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    throw unsupportedSchema(`The ${source} ${CODEX_HOOKS_TABLE_KEY} table is not an object`)
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_EVENTS.has(key)) {
      throw unsupportedSchema(`Unknown hook event ${key} in ${source}`)
    }
    const groups = value[key]
    if (!Array.isArray(groups)) {
      throw unsupportedSchema(`Hook event ${key} in ${source} is not an array`)
    }
    for (const group of groups) {
      if (!isRecord(group)) {
        throw unsupportedSchema(`Hook event ${key} in ${source} contains a non-object group`)
      }
    }
  }
}

function unsupportedSchema(message: string): CodexAdapterError {
  return new CodexAdapterError({
    code: 'CODEX_SCHEMA_UNSUPPORTED',
    message,
    remediation:
      'Update the OpenCloudBox Codex adapter to a release that certifies this Codex schema; the adapter will not edit an unrecognized hooks table.',
  })
}

function hooksValue(document: Record<string, unknown> | null): unknown {
  if (document === null) return undefined
  return document[CODEX_HOOKS_TABLE_KEY]
}

export function detectCodexSchema(
  versionOutput: string,
  documents: ParsedCodexDocuments,
): CodexSchemaDescriptor {
  const release = assertSupportedCodexVersion(parseCodexVersion(versionOutput))
  validateHooksTable(hooksValue(documents.config), 'config.toml')
  validateHooksTable(hooksValue(documents.hooks), 'hooks.json')
  return codexSchemaDescriptor(release)
}

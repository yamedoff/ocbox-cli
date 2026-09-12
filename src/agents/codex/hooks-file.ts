import { HOOK_OWNED_ID } from './hook-helper.js'

export const HOOKS_SCHEMA_VERSION = 1 as const

export const FIXTURE_HOOKS_SCHEMA = 'ocbox-codex-fixture-hooks-v1' as const

export interface OwnedHookEntry {
  readonly id: string
  readonly command: readonly string[]
  readonly matcher: string
  readonly sessionId: string
  readonly sync: 'explicit'
}

export interface HooksFileDocument {
  readonly schemaVersion: typeof HOOKS_SCHEMA_VERSION
  readonly fixture: typeof FIXTURE_HOOKS_SCHEMA
  readonly hooks: readonly OwnedHookEntry[]
}

export class CodexHooksError extends Error {
  readonly code = 'HOOKS_PARSE_ERROR' as const
  constructor(message: string) {
    super(message)
    this.name = 'CodexHooksError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function buildOwnedHookEntry(sessionId: string, command: readonly string[]): OwnedHookEntry {
  return {
    id: HOOK_OWNED_ID,
    command: [...command],
    matcher: 'shell',
    sessionId,
    sync: 'explicit',
  }
}

export function parseHooksJson(text: string): HooksFileDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new CodexHooksError('Codex hooks file is not parseable JSON; refusing to merge.')
  }
  if (!isRecord(parsed)) throw new CodexHooksError('Codex hooks file root is not an object.')
  const hooks = parsed['hooks']
  if (!Array.isArray(hooks)) throw new CodexHooksError('Codex hooks file has no hooks array.')
  return {
    schemaVersion: HOOKS_SCHEMA_VERSION,
    fixture: FIXTURE_HOOKS_SCHEMA,
    hooks: hooks.filter(isRecord).map((entry) => ({
      id: typeof entry['id'] === 'string' ? entry['id'] : '',
      command: Array.isArray(entry['command'])
        ? entry['command'].filter((item): item is string => typeof item === 'string')
        : [],
      matcher: typeof entry['matcher'] === 'string' ? entry['matcher'] : 'shell',
      sessionId: typeof entry['sessionId'] === 'string' ? entry['sessionId'] : '',
      sync: 'explicit',
    })),
  }
}

export function mergeOwnedHooks(
  existing: HooksFileDocument | null,
  owned: OwnedHookEntry,
): HooksFileDocument {
  const rest = (existing?.hooks ?? []).filter((entry) => entry.id !== HOOK_OWNED_ID)
  return {
    schemaVersion: HOOKS_SCHEMA_VERSION,
    fixture: FIXTURE_HOOKS_SCHEMA,
    hooks: [...rest, owned],
  }
}

export function removeOwnedHooks(existing: HooksFileDocument | null): {
  readonly document: HooksFileDocument
  readonly removed: boolean
} {
  const rest = (existing?.hooks ?? []).filter((entry) => entry.id !== HOOK_OWNED_ID)
  const removed = rest.length !== (existing?.hooks ?? []).length
  return {
    document: {
      schemaVersion: HOOKS_SCHEMA_VERSION,
      fixture: FIXTURE_HOOKS_SCHEMA,
      hooks: rest,
    },
    removed,
  }
}

export function serializeHooksJson(document: HooksFileDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

export function hasOwnedHook(document: HooksFileDocument | null): boolean {
  return (document?.hooks ?? []).some((entry) => entry.id === HOOK_OWNED_ID)
}

import { z } from 'zod'
import {
  type CodexJsonValue,
  CodexJsonValueSchema,
  canonicalJson,
  deepEqual,
  isRecord,
  sha256,
} from './document.js'

export const CODEX_HOOK_EVENTS = [
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
] as const

export const CodexHookEventSchema = z.enum(CODEX_HOOK_EVENTS)
export type CodexHookEvent = z.infer<typeof CodexHookEventSchema>

export const CODEX_HOOKS_TABLE_KEY = 'hooks'

export const CODEX_HOOK_REPRESENTATIONS = ['config-toml', 'hooks-json'] as const
export const CodexHookRepresentationSchema = z.enum(CODEX_HOOK_REPRESENTATIONS)
export type CodexHookRepresentation = z.infer<typeof CodexHookRepresentationSchema>

export const FRAGMENT_ID_PATTERN = /^ocbox-codex-[0-9a-f]{32}$/

export const CodexHookFragmentSchema = z.strictObject({
  id: z.string().regex(FRAGMENT_ID_PATTERN),
  event: CodexHookEventSchema,
  matcher: z.string().min(1).max(256).nullable(),
  group: CodexJsonValueSchema,
})

export type CodexHookFragment = z.infer<typeof CodexHookFragmentSchema>

export interface CodexDesiredFragment {
  readonly event: CodexHookEvent
  readonly matcher: string | null
  readonly group: CodexJsonValue
}

export function fragmentId(fragment: CodexDesiredFragment): string {
  const identity = canonicalJson({
    event: fragment.event,
    matcher: fragment.matcher,
    group: fragment.group,
  })
  return `ocbox-codex-${sha256(identity).slice(0, 32)}`
}

export function toOwnedFragment(fragment: CodexDesiredFragment): CodexHookFragment {
  return {
    id: fragmentId(fragment),
    event: fragment.event,
    matcher: fragment.matcher,
    group: fragment.group,
  }
}

export function readHooksTable(document: unknown): Record<string, unknown> | null {
  if (!isRecord(document)) return null
  const table = document[CODEX_HOOKS_TABLE_KEY]
  if (table === undefined) return null
  if (!isRecord(table)) return null
  return table
}

export function eventGroups(table: Record<string, unknown>, event: CodexHookEvent): unknown[] {
  const value = table[event]
  return Array.isArray(value) ? value : []
}

export function hasAnyEventKey(table: Record<string, unknown>): boolean {
  return CODEX_HOOK_EVENTS.some((event) => Object.hasOwn(table, event))
}

export function ensureGroup(table: Record<string, unknown>, fragment: CodexHookFragment): boolean {
  const groups = eventGroups(table, fragment.event)
  if (groups.some((group) => deepEqual(group, fragment.group))) return false
  table[fragment.event] = [...groups, fragment.group]
  return true
}

export function removeGroup(table: Record<string, unknown>, fragment: CodexHookFragment): boolean {
  const groups = eventGroups(table, fragment.event)
  const index = groups.findIndex((group) => deepEqual(group, fragment.group))
  if (index === -1) return false
  const remaining = groups.filter((_, position) => position !== index)
  if (remaining.length === 0) delete table[fragment.event]
  else table[fragment.event] = remaining
  return true
}

export function pruneEmptyHooksTable(document: Record<string, unknown>): void {
  const table = readHooksTable(document)
  if (table === null) return
  const remaining = Object.keys(table)
  if (remaining.length === 0) delete document[CODEX_HOOKS_TABLE_KEY]
}

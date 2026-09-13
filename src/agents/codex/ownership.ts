import { type CodexJsonValue, type MutableDocument, deepEqual, isRecord } from './document.js'
import {
  CODEX_HOOK_EVENTS,
  type CodexHookEvent,
  type CodexHookFragment,
  eventGroups,
  pruneEmptyHooksTable,
  readHooksTable,
  toOwnedFragment,
} from './hooks.js'

/**
 * Strict ownership detection for persisted Codex hooks.
 *
 * The manifest records the exact fragment bytes the adapter wrote, but after a
 * crash, a legacy manifest, or a representation switch those fragments can
 * survive with no recorded owner. Ownership therefore cannot depend on the
 * manifest alone: it must be provable from the persisted command itself.
 *
 * A group is adapter-owned only when one of its command hooks invokes the
 * `ocbox` binary either as the installed hook entrypoint
 * (`ocbox agent hook codex --session …`) or as the legacy routed shape
 * (`ocbox exec --session …`). Both shapes carry an explicit `--session`
 * selector, so unrelated user commands (including user edits that replaced
 * the owned command) are never claimed.
 */

function stripQuotes(token: string): string {
  return token.replaceAll('"', '').replaceAll("'", '')
}

function binaryBaseName(token: string): string {
  const normalized = stripQuotes(token)
  const segments = normalized.split(/[\\/]/)
  return (segments[segments.length - 1] ?? '').toLowerCase()
}

/** Splits a shell command string into bare words, honoring single/double quotes. */
export function tokenizeHookCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let index = 0
  while (index < command.length) {
    const character = command[index] as string
    if (character === "'") {
      index += 1
      while (index < command.length && command[index] !== "'") {
        current += command[index]
        index += 1
      }
      if (index < command.length) index += 1
      continue
    }
    if (character === '"') {
      index += 1
      while (index < command.length && command[index] !== '"') {
        current += command[index]
        index += 1
      }
      if (index < command.length) index += 1
      continue
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      index += 1
      continue
    }
    current += character
    index += 1
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

export function isAdapterOwnedCommand(command: unknown): boolean {
  let words: string[]
  if (Array.isArray(command)) {
    words = command.filter((token): token is string => typeof token === 'string')
  } else if (typeof command === 'string') {
    words = tokenizeHookCommand(command)
  } else {
    return false
  }
  const binIndex = words.findIndex((token) => {
    const base = binaryBaseName(token)
    return base === 'ocbox' || base === 'ocbox.exe'
  })
  if (binIndex === -1) return false
  const rest = words.slice(binIndex)
  if (!rest.includes('--session')) return false
  if (rest.includes('exec')) return true
  const agentIndex = rest.indexOf('agent')
  const hookIndex = rest.indexOf('hook')
  const codexIndex = rest.indexOf('codex')
  return agentIndex !== -1 && hookIndex === agentIndex + 1 && codexIndex === hookIndex + 1
}

export function isAdapterOwnedGroup(group: unknown): boolean {
  if (!isRecord(group)) return false
  const hooks = group['hooks']
  if (!Array.isArray(hooks)) return false
  return hooks.some(
    (entry) =>
      isRecord(entry) && entry['type'] === 'command' && isAdapterOwnedCommand(entry['command']),
  )
}

export function groupMatcher(group: unknown): string | null {
  if (!isRecord(group)) return null
  const matcher = group['matcher']
  return typeof matcher === 'string' ? matcher : null
}

export function fragmentFromGroup(event: CodexHookEvent, group: unknown): CodexHookFragment {
  return toOwnedFragment({
    event,
    matcher: groupMatcher(group),
    group: group as CodexJsonValue,
  })
}

/**
 * Enumerates every adapter-owned fragment present in either representation of a
 * layer, independent of any manifest. Ordering follows the known event table so
 * results are deterministic.
 */
export function ownedFragmentsInDocument(
  document: Record<string, unknown> | null,
): readonly CodexHookFragment[] {
  const table = readHooksTable(document)
  if (table === null) return []
  const fragments: CodexHookFragment[] = []
  for (const event of CODEX_HOOK_EVENTS) {
    for (const group of eventGroups(table, event)) {
      if (!isAdapterOwnedGroup(group)) continue
      fragments.push(fragmentFromGroup(event, group))
    }
  }
  return fragments
}

export function ownedFragmentsInDocuments(
  documents: readonly (Record<string, unknown> | null)[],
): readonly CodexHookFragment[] {
  const unique = new Map<string, CodexHookFragment>()
  for (const document of documents) {
    for (const fragment of ownedFragmentsInDocument(document)) {
      unique.set(fragment.id, fragment)
    }
  }
  return [...unique.values()]
}

export function fragmentKey(fragment: Pick<CodexHookFragment, 'event' | 'group'>): string {
  return `${fragment.event}\u0000${JSON.stringify(fragment.group)}`
}

export function isSameFragment(
  left: Pick<CodexHookFragment, 'event' | 'group'>,
  right: Pick<CodexHookFragment, 'event' | 'group'>,
): boolean {
  return fragmentKey(left) === fragmentKey(right)
}

/**
 * Removes every fragment in `remove` (matching by event + exact group) from the
 * hooks table, pruning the table when nothing remains. Returns the number of
 * groups actually removed.
 */
export function removeOwnedFragments(
  document: MutableDocument,
  remove: readonly CodexHookFragment[],
): number {
  const table = readHooksTable(document)
  if (table === null || remove.length === 0) return 0
  let removed = 0
  for (const event of CODEX_HOOK_EVENTS) {
    const groups = eventGroups(table, event)
    if (groups.length === 0) continue
    const keep = groups.filter(
      (group) =>
        !remove.some((fragment) => fragment.event === event && deepEqual(fragment.group, group)),
    )
    removed += groups.length - keep.length
    if (keep.length === 0) delete table[event]
    else table[event] = keep
  }
  pruneEmptyHooksTable(document)
  return removed
}

import { parse, stringify } from 'smol-toml'
import { type CodexJsonValue, deepEqual, isRecord } from './document.js'
import {
  CODEX_HOOK_EVENTS,
  type CodexHookEvent,
  type CodexHookFragment,
  readHooksTable,
} from './hooks.js'

/**
 * Comment-preserving TOML editing for the owned `hooks` table.
 *
 * `smol-toml` cannot round-trip comments or original formatting, so any adapter
 * write that reserialized the whole `config.toml` destroyed user comments and
 * styling outside the owned hook. This module instead splices only the owned
 * array-of-tables group blocks (the exact shape the adapter writes), leaving
 * every other byte of the document untouched. A rare inline `[hooks]` table
 * falls back to replacing just the hooks region, still preserving the rest of
 * the file.
 */

export interface TomlHooksEdit {
  readonly add: readonly CodexHookFragment[]
  readonly remove: readonly CodexHookFragment[]
}

export type TomlEditStrategy = 'noop' | 'surgical' | 'region' | 'append'

export interface TomlEditResult {
  readonly text: string
  readonly strategy: TomlEditStrategy
}

interface TomlSection {
  readonly start: number
  readonly end: number
  readonly isHeader: boolean
  readonly path: readonly string[]
  readonly array: boolean
}

interface LineHeader {
  readonly path: readonly string[]
  readonly array: boolean
}

interface GroupSite {
  readonly start: number
  readonly end: number
  readonly event: CodexHookEvent
  readonly group: CodexJsonValue
}

const EVENT_SET = new Set<string>(CODEX_HOOK_EVENTS)

function parseKeyPath(inner: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  let index = 0
  while (index < inner.length) {
    const character = inner[index] as string
    if (quote !== null) {
      if (character === quote) quote = null
      else current += character
      index += 1
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      index += 1
      continue
    }
    if (character === '.') {
      parts.push(current.trim())
      current = ''
      index += 1
      continue
    }
    current += character
    index += 1
  }
  parts.push(current.trim())
  return parts.filter((part) => part.length > 0)
}

function parseHeader(content: string): LineHeader | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith('[')) return null
  const double = /^\[\[(.+?)\]\]\s*(?:#.*)?$/.exec(trimmed)
  if (double !== null) return { path: parseKeyPath(double[1] as string), array: true }
  const single = /^\[(.+?)\]\s*(?:#.*)?$/.exec(trimmed)
  if (single !== null) return { path: parseKeyPath(single[1] as string), array: false }
  return null
}

function scanSections(text: string): TomlSection[] {
  const lines: Array<{ start: number; header: LineHeader | null }> = []
  let index = 0
  let lineStart = 0
  let depth = 0
  type Mode = 'normal' | 'basic' | 'literal' | 'multibasic' | 'multiliteral' | 'comment'
  let mode: Mode = 'normal'
  let lineDepthBefore = 0

  const push = (contentEnd: number): void => {
    const content = text.slice(lineStart, contentEnd)
    const header =
      lineDepthBefore === 0 &&
      mode !== 'basic' &&
      mode !== 'literal' &&
      mode !== 'multibasic' &&
      mode !== 'multiliteral'
        ? parseHeader(content)
        : null
    lines.push({ start: lineStart, header })
    if (header !== null) depth = 0
  }

  while (index <= text.length) {
    if (index === text.length || text[index] === '\n') {
      push(index)
      lineStart = index + 1
      lineDepthBefore = depth
      index += 1
      if (index > text.length) break
      mode = mode === 'comment' ? 'normal' : mode
      continue
    }
    const character = text[index] as string
    if (mode === 'comment') {
      index += 1
      continue
    }
    if (mode === 'basic') {
      if (character === '\\') index += 2
      else {
        if (character === '"') mode = 'normal'
        index += 1
      }
      continue
    }
    if (mode === 'literal') {
      if (character === "'") mode = 'normal'
      index += 1
      continue
    }
    if (mode === 'multibasic') {
      if (text.startsWith('"""', index)) {
        mode = 'normal'
        index += 3
      } else index += 1
      continue
    }
    if (mode === 'multiliteral') {
      if (text.startsWith("'''", index)) {
        mode = 'normal'
        index += 3
      } else index += 1
      continue
    }
    if (character === '#') {
      mode = 'comment'
      index += 1
      continue
    }
    if (character === '"') {
      if (text.startsWith('"""', index)) {
        mode = 'multibasic'
        index += 3
      } else {
        mode = 'basic'
        index += 1
      }
      continue
    }
    if (character === "'") {
      if (text.startsWith("'''", index)) {
        mode = 'multiliteral'
        index += 3
      } else {
        mode = 'literal'
        index += 1
      }
      continue
    }
    if (character === '[' || character === '{') {
      depth += 1
      index += 1
      continue
    }
    if (character === ']' || character === '}') {
      depth -= 1
      index += 1
      continue
    }
    index += 1
  }

  const sections: TomlSection[] = []
  let current: {
    start: number
    end: number
    isHeader: boolean
    path: string[]
    array: boolean
  } | null = null
  for (const line of lines) {
    if (line.header !== null) {
      if (current === null) {
        sections.push({ start: 0, end: line.start, isHeader: false, path: [], array: false })
      } else {
        sections.push({ ...current, end: line.start })
      }
      current = {
        start: line.start,
        end: text.length,
        isHeader: true,
        path: [...line.header.path],
        array: line.header.array,
      }
    }
  }
  if (current === null) {
    sections.push({ start: 0, end: text.length, isHeader: false, path: [], array: false })
  } else {
    sections.push({ ...current, end: text.length })
  }
  return sections
}

function isHooksSection(section: TomlSection): boolean {
  return section.isHeader && section.path[0] === 'hooks'
}

function isArrayGroupHeader(section: TomlSection): boolean {
  return (
    section.isHeader &&
    section.array &&
    section.path.length === 2 &&
    section.path[0] === 'hooks' &&
    EVENT_SET.has(section.path[1] as string)
  )
}

function isDescendant(path: readonly string[], base: readonly string[]): boolean {
  if (path.length <= base.length) return false
  return base.every((segment, index) => path[index] === segment)
}

function serializeGroupBlock(event: CodexHookEvent, group: CodexJsonValue): string {
  return stringify({ hooks: { [event]: [group] } }).trimEnd()
}

function enumerateGroupSites(text: string, sections: readonly TomlSection[]): GroupSite[] {
  const sites: GroupSite[] = []
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index] as TomlSection
    if (!isArrayGroupHeader(section)) continue
    let next = index + 1
    while (
      next < sections.length &&
      (sections[next] as TomlSection).isHeader &&
      (sections[next] as TomlSection).array &&
      isDescendant((sections[next] as TomlSection).path, section.path)
    ) {
      next += 1
    }
    const end = next < sections.length ? (sections[next] as TomlSection).start : text.length
    const event = section.path[1] as CodexHookEvent
    try {
      const document: unknown = parse(text.slice(section.start, end))
      if (isRecord(document) && isRecord(document['hooks'])) {
        const groups = document['hooks'][event]
        if (Array.isArray(groups) && groups.length === 1) {
          sites.push({ start: section.start, end, event, group: groups[0] as CodexJsonValue })
        }
      }
    } catch {
      void 0
    }
    index = next - 1
  }
  return sites
}

interface Range {
  readonly start: number
  readonly end: number
}

interface Edit {
  readonly start: number
  readonly end: number
  readonly insert: string
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start
    return left.end - left.start - (right.end - right.start)
  })
  let output = ''
  let cursor = 0
  for (const edit of sorted) {
    if (edit.start < cursor) continue
    output += text.slice(cursor, edit.start)
    output += edit.insert
    cursor = Math.max(cursor, edit.end)
  }
  output += text.slice(cursor)
  return output
}

function contentEnd(text: string, start: number, end: number): number {
  let index = end
  while (index > start && /\s/.test(text[index - 1] as string)) index -= 1
  return index
}

function editArrayForm(
  text: string,
  sections: readonly TomlSection[],
  edit: TomlHooksEdit,
): TomlEditResult {
  const sites = enumerateGroupSites(text, sections)
  if (sites.length === 0) return replaceHooksRegion(text, sections, edit)
  const deletions: Range[] = []
  for (const site of sites) {
    const matched = edit.remove.some(
      (fragment) => fragment.event === site.event && deepEqual(fragment.group, site.group),
    )
    if (matched) deletions.push({ start: site.start, end: site.end })
  }
  const existing = (event: CodexHookEvent, group: CodexJsonValue): boolean =>
    sites.some((site) => site.event === event && deepEqual(site.group, group))
  const missing = edit.add.filter((fragment) => !existing(fragment.event, fragment.group))
  if (deletions.length === 0 && missing.length === 0) {
    return { text, strategy: 'noop' }
  }
  const appendIndex = sites.reduce((maximum, site) => Math.max(maximum, site.end), 0)
  const edits: Edit[] = deletions.map((range) => ({ ...range, insert: '' }))
  if (missing.length > 0) {
    const block = missing
      .map((fragment) => serializeGroupBlock(fragment.event, fragment.group))
      .join('\n\n')
    const before = text.slice(0, appendIndex)
    const prefix = before.length === 0 || before.endsWith('\n') ? '' : '\n'
    edits.push({ start: appendIndex, end: appendIndex, insert: `${prefix}${block}\n` })
  }
  return { text: applyEdits(text, edits), strategy: 'surgical' }
}

function replaceHooksRegion(
  text: string,
  sections: readonly TomlSection[],
  edit: TomlHooksEdit,
): TomlEditResult {
  const hooksIndices = sections
    .map((section, index) => (isHooksSection(section) ? index : -1))
    .filter((index) => index >= 0)
  if (hooksIndices.length === 0) {
    return appendHooksTable(text, edit)
  }
  const first = hooksIndices[0] as number
  const last = hooksIndices[hooksIndices.length - 1] as number
  const contiguous = sections
    .slice(first, last + 1)
    .every((section) => isHooksSection(section) || section.path.length === 0)
  if (!contiguous) {
    return { text, strategy: 'noop' }
  }
  const start = (sections[first] as TomlSection).start
  const end = contentEnd(text, start, (sections[last] as TomlSection).end)
  const hooks = applyHooksEdit(text.slice(start, end), edit)
  const replacement = hooks === null ? '' : `${stringify({ hooks }).trimEnd()}\n`
  return { text: `${text.slice(0, start)}${replacement}${text.slice(end)}`, strategy: 'region' }
}

function applyHooksEdit(regionText: string, edit: TomlHooksEdit): Record<string, unknown> | null {
  let document: Record<string, unknown>
  try {
    document = parse(regionText) as Record<string, unknown>
  } catch {
    return null
  }
  const table = readHooksTable(document)
  if (table === null) return null
  for (const fragment of edit.remove) {
    const groups = table[fragment.event]
    if (!Array.isArray(groups)) continue
    const keep = groups.filter((group) => !deepEqual(group, fragment.group))
    if (keep.length === 0) delete table[fragment.event]
    else table[fragment.event] = keep
  }
  for (const fragment of edit.add) {
    const groups = Array.isArray(table[fragment.event]) ? (table[fragment.event] as unknown[]) : []
    if (!groups.some((group) => deepEqual(group, fragment.group))) {
      table[fragment.event] = [...groups, fragment.group]
    }
  }
  return Object.keys(table).length === 0 ? null : table
}

function appendHooksTable(text: string, edit: TomlHooksEdit): TomlEditResult {
  const additions = edit.add
  if (additions.length === 0) return { text, strategy: 'noop' }
  const block = additions
    .map((fragment) => serializeGroupBlock(fragment.event, fragment.group))
    .join('\n\n')
  const separator = text.length === 0 ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  return { text: `${text}${separator}${block}\n`, strategy: 'append' }
}

export function editTomlHooks(originalText: string, edit: TomlHooksEdit): TomlEditResult {
  if (edit.add.length === 0 && edit.remove.length === 0) {
    return { text: originalText, strategy: 'noop' }
  }
  const sections = scanSections(originalText)
  const hasArrayForm = sections.some(isArrayGroupHeader)
  if (hasArrayForm) return editArrayForm(originalText, sections, edit)
  return replaceHooksRegion(originalText, sections, edit)
}

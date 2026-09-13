export const OWNED_MARKER = 'ocbox-claude-code' as const
export const OWNED_HOOK_COMMAND_FRAGMENT = 'ocbox agent hook claude-code' as const
export const OWNED_PERMISSION_ALLOW = 'Bash(ocbox exec:*)' as const
export const COVERED_HOOK_EVENT = 'PreToolUse' as const
export const COVERED_HOOK_MATCHER = 'Bash' as const

export interface OwnedHookEntry {
  readonly type: 'command'
  readonly command: string
}

export interface OwnedHookMatcher {
  readonly matcher: string
  readonly hooks: readonly OwnedHookEntry[]
}

export interface ClaudePermissions {
  readonly allow?: unknown
  readonly deny?: unknown
  readonly ask?: unknown
  readonly allowManagedPermissionRulesOnly?: unknown
  readonly [key: string]: unknown
}

export interface ClaudeHookRecord {
  readonly matcher?: unknown
  readonly hooks?: unknown
  readonly command?: unknown
  readonly type?: unknown
  readonly [key: string]: unknown
}

export interface ClaudeSettingsDocument {
  readonly hooks?: unknown
  readonly permissions?: unknown
  readonly allowManagedHooksOnly?: unknown
  readonly [key: string]: unknown
}

export interface MutableClaudeSettings {
  hooks?: unknown
  permissions?: unknown
  [key: string]: unknown
}

export interface MutableClaudePermissions {
  allow?: unknown
  deny?: unknown
  ask?: unknown
  [key: string]: unknown
}

export interface MutableHookEvents {
  PreToolUse?: unknown
  [key: string]: unknown
}

export interface SettingsParseIssue {
  readonly path: string
  readonly message: string
}

export interface ParsedSettingsFile {
  readonly path: string
  readonly present: boolean
  readonly document: ClaudeSettingsDocument
  readonly issues: readonly SettingsParseIssue[]
}

export function parseSettingsJson(path: string, raw: string | null): ParsedSettingsFile {
  if (raw === null) {
    return { path, present: false, document: {}, issues: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      path,
      present: true,
      document: {},
      issues: [{ path, message: 'settings file is not valid JSON; refusing to merge' }],
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      path,
      present: true,
      document: {},
      issues: [{ path, message: 'settings root must be a JSON object; refusing to merge' }],
    }
  }
  const document = parsed as ClaudeSettingsDocument
  const issues: SettingsParseIssue[] = []
  const hooks = document.hooks
  if (
    hooks !== undefined &&
    (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks))
  ) {
    issues.push({ path, message: '"hooks" key must be an object keyed by event name' })
  } else if (hooks !== undefined && typeof hooks === 'object' && hooks !== null) {
    for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
      if (!Array.isArray(entries)) {
        issues.push({
          path,
          message: `"hooks.${event}" must be an array; string matchers belong inside entries`,
        })
        continue
      }
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          issues.push({
            path,
            message: `"hooks.${event}" entries must be objects with matcher and hooks`,
          })
          continue
        }
        const record = entry as ClaudeHookRecord
        if (Array.isArray(record.matcher)) {
          issues.push({
            path,
            message: `"hooks.${event}" matcher must be a single string using "|" (array matchers match nothing and invalidate the file)`,
          })
        }
        if (record.hooks !== undefined && !Array.isArray(record.hooks)) {
          issues.push({ path, message: `"hooks.${event}" entry "hooks" must be an array` })
        }
      }
    }
  }
  const permissions = document.permissions
  if (
    permissions !== undefined &&
    (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions))
  ) {
    issues.push({ path, message: '"permissions" key must be an object with allow/deny/ask arrays' })
  } else if (permissions !== undefined && typeof permissions === 'object' && permissions !== null) {
    for (const key of ['allow', 'deny', 'ask']) {
      const value = (permissions as Record<string, unknown>)[key]
      if (value !== undefined && !Array.isArray(value)) {
        issues.push({ path, message: `"permissions.${key}" must be an array of rule strings` })
      }
    }
  }
  return { path, present: true, document, issues }
}

<const OWNED_HOOK_COMMAND_PATTERN =
  /^ocbox agent hook claude-code(?: --session (\S+))?$/

export function parseOwnedHookCommand(
  command: unknown,
): { readonly sessionId: string | null } | null {
  if (typeof command !== 'string') return null
  const match = OWNED_HOOK_COMMAND_PATTERN.exec(command)
  if (match === null) return null
  return { sessionId: match[1] ?? null }
}

export function isOwnedHookCommand(command: unknown): boolean {
  return parseOwnedHookCommand(command) !== null
}

export function hookObjectOwned(hook: unknown): boolean {
  if (hook === null || typeof hook !== 'object' || Array.isArray(hook)) return false
  return isOwnedHookCommand((hook as ClaudeHookRecord).command)
}

export function hookEntryOwned(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false
  const record = entry as ClaudeHookRecord
  const hooks = record.hooks
  if (!Array.isArray(hooks)) return false
  return hooks.some(hookObjectOwned)
}

export function permissionRuleOwned(rule: unknown): boolean {
  return rule === OWNED_PERMISSION_ALLOW
}

export type PermissionRuleKind = 'any' | 'exact' | 'prefix'

export interface ParsedPermissionRule {
  readonly raw: string
  readonly tool: string
  readonly kind: PermissionRuleKind
  readonly value: string | null
}

// Claude Code permission rules are either a bare tool name (`Bash`) matching every
// call of that tool, an exact specifier (`Bash(npm run build)`), or a colon-star
// prefix (`Bash(ocbox exec:*)`, `Bash(python3:*)`). Anything else is not a rule we
// can reason about and is treated as non-matching.
export function parsePermissionRule(rule: string): ParsedPermissionRule | null {
  if (typeof rule !== 'string') return null
  const trimmed = rule.trim()
  if (trimmed.length === 0) return null
  const open = trimmed.indexOf('(')
  if (open === -1) {
    return { raw: trimmed, tool: trimmed, kind: 'any', value: null }
  }
  if (trimmed[trimmed.length - 1] !== ')') return null
  const tool = trimmed.slice(0, open).trim()
  if (tool.length === 0) return null
  const inner = trimmed.slice(open + 1, -1)
  if (inner.length === 0) {
    return { raw: trimmed, tool, kind: 'any', value: null }
  }
  if (inner.endsWith(':*')) {
    return { raw: trimmed, tool, kind: 'prefix', value: inner.slice(0, -2) }
  }
  return { raw: trimmed, tool, kind: 'exact', value: inner }
}

export function permissionRuleMatchesCommand(
  rule: string,
  toolName: string,
  command: string,
): boolean {
  const parsed = parsePermissionRule(rule)
  if (parsed === null || parsed.tool !== toolName) return false
  if (parsed.kind === 'any') return true
  if (parsed.kind === 'exact') return command === parsed.value
  return command.startsWith(parsed.value as string)
}

export function permissionRulesOverlap(left: string, right: string): boolean {
  const a = parsePermissionRule(left)
  const b = parsePermissionRule(right)
  if (a === null || b === null || a.tool !== b.tool) return false
  if (a.kind === 'any' || b.kind === 'any') return true
  if (a.kind === 'exact' && b.kind === 'exact') return a.value === b.value
  const prefix = a.kind === 'prefix' ? a : b
  const other = a.kind === 'prefix' ? b : a
  if (prefix.kind !== 'prefix') return false
  if (other.kind === 'prefix') {
    return (
      (prefix.value as string).startsWith(other.value as string) ||
      (other.value as string).startsWith(prefix.value as string)
    )
  }
  return (other.value as string).startsWith(prefix.value as string)
}

export function shadowingPermissionRules(
  rules: readonly string[],
  ownedRule: string = OWNED_PERMISSION_ALLOW,
): string[] {
  const seen = new Set<string>()
  const shadowing: string[] = []
  for (const rule of rules) {
    if (!permissionRulesOverlap(rule, ownedRule)) continue
    if (seen.has(rule)) continue
    seen.add(rule)
    shadowing.push(rule)
  }
  return shadowing
}

export function collectDenyAskRules(document: ClaudeSettingsDocument): {
  readonly deny: string[]
  readonly ask: string[]
} {
  const permissions = document.permissions
  if (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions)) {
    return { deny: [], ask: [] }
  }
  const record = permissions as ClaudePermissions
  const pick = (key: 'allow' | 'deny' | 'ask'): string[] => {
    const value = record[key]
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string')
  }
  return { deny: pick('deny'), ask: pick('ask') }
}

export function hasManagedHookLock(document: ClaudeSettingsDocument): boolean {
  const flag = document.allowManagedHooksOnly
  if (flag === true) return true
  const permissions = document.permissions
  if (permissions !== null && typeof permissions === 'object' && !Array.isArray(permissions)) {
    const record = permissions as ClaudePermissions
    if (record.allowManagedPermissionRulesOnly === true) return true
  }
  return false
}

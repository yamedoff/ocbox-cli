import { ClaudeCodeAdapterError } from './errors.js'

export const PINNED_CLAUDE_CODE_VERSION = '2.0.51' as const
export const CLAUDE_CODE_PINNED_VERSION = PINNED_CLAUDE_CODE_VERSION
export const CLAUDE_CODE_SETTINGS_SCHEMA_REVISION = 1 as const

export const CLAUDE_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionStart',
  'SessionEnd',
] as const

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number]

export const CLAUDE_TOOL_MATCHERS = [
  'Bash',
  'BashOutput',
  'Edit',
  'Glob',
  'Grep',
  'KillShell',
  'LS',
  'MultiEdit',
  'NotebookEdit',
  'Read',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
] as const

export interface ClaudeCodeVersionDescriptor {
  readonly version: string
  readonly settingsSchemaRevision: number
  readonly hookEvents: readonly ClaudeHookEvent[]
  readonly toolMatchers: readonly string[]
}

export const CLAUDE_CODE_VERSION_PINS: readonly ClaudeCodeVersionDescriptor[] = [
  {
    version: CLAUDE_CODE_PINNED_VERSION,
    settingsSchemaRevision: CLAUDE_CODE_SETTINGS_SCHEMA_REVISION,
    hookEvents: CLAUDE_HOOK_EVENTS,
    toolMatchers: CLAUDE_TOOL_MATCHERS,
  },
]

export interface ParsedClaudeVersion {
  readonly raw: string
  readonly version: string
  readonly supported: boolean
}

export function parseClaudeVersionOutput(raw: string): ParsedClaudeVersion {
  const trimmed = raw.trim()
  const match = /(\d+\.\d+\.\d+)/.exec(trimmed)
  const version = match?.[1] ?? ''
  return {
    raw: trimmed,
    version,
    supported: version === PINNED_CLAUDE_CODE_VERSION,
  }
}

export interface VersionGateResult {
  readonly supported: boolean
  readonly installed: string
  readonly pinned: typeof PINNED_CLAUDE_CODE_VERSION
  readonly remediation: string
}

export function gateClaudeVersion(raw: string): VersionGateResult {
  const parsed = parseClaudeVersionOutput(raw)
  const remediation =
    `Unsupported Claude Code version "${parsed.version || parsed.raw}". ` +
    `This adapter is pinned to Claude Code ${PINNED_CLAUDE_CODE_VERSION} ` +
    `(verified hooks key, PreToolUse matcher, and permissions schema). ` +
    `Install ${PINNED_CLAUDE_CODE_VERSION}, then re-run doctor. ` +
    `Setup refuses to guess newer or older schemas and fails closed.`
  return {
    supported: parsed.supported,
    installed: parsed.version === '' ? parsed.raw : parsed.version,
    pinned: PINNED_CLAUDE_CODE_VERSION,
    remediation,
  }
}

const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/

export function parseClaudeCodeVersion(raw: string): string {
  const match = VERSION_PATTERN.exec(raw.trim())
  if (match === null) {
    throw new ClaudeCodeAdapterError(
      'UNSUPPORTED_VERSION',
      'Could not read a semantic Claude Code version',
      'Run "claude --version" and confirm the output begins with a major.minor.patch version.',
    )
  }
  return `${match[1]}.${match[2]}.${match[3]}`
}

export function detectClaudeCodeVersion(raw: string): ClaudeCodeVersionDescriptor {
  const version = parseClaudeCodeVersion(raw)
  const descriptor = CLAUDE_CODE_VERSION_PINS.find((pin) => pin.version === version)
  if (descriptor === undefined) {
    throw new ClaudeCodeAdapterError(
      'UNSUPPORTED_VERSION',
      `Claude Code ${version} is not a supported settings/hook schema`,
      `Install the pinned Claude Code ${CLAUDE_CODE_PINNED_VERSION} release, or extend the adapter pins before enabling routing.`,
    )
  }
  return descriptor
}

export function settingsSchemaRevisionFor(version: string): number {
  return detectClaudeCodeVersion(version).settingsSchemaRevision
}

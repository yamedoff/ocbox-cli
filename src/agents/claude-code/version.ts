import { ClaudeCodeAdapterError } from './errors.js'

export const PINNED_CLAUDE_CODE_VERSION = '2.0.51' as const
export const CLAUDE_CODE_PINNED_VERSION = PINNED_CLAUDE_CODE_VERSION
export const CLAUDE_CODE_SETTINGS_SCHEMA_REVISION = 1 as const

export const TEST_HARNESS_ENV = 'OCBOX_TEST_MODE' as const

export const CLAUDE_CODE_PINNED_SURFACE_FIXTURE =
  'test/fixtures/claude-code/pinned-surface.json' as const

export const CLAUDE_CODE_PINNED_SURFACE_EVIDENCE = {
  fixture: CLAUDE_CODE_PINNED_SURFACE_FIXTURE,
  label: `static offline pin for Claude Code ${PINNED_CLAUDE_CODE_VERSION}`,
  note: 'Consolidated from the adapter source; not captured from a live binary in this environment. Re-capture from the installed pinned binary before changing PINNED_CLAUDE_CODE_VERSION (live-only gate).',
} as const

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
  readonly evidence: string
}

export const CLAUDE_CODE_VERSION_PINS: readonly ClaudeCodeVersionDescriptor[] = [
  {
    version: CLAUDE_CODE_PINNED_VERSION,
    settingsSchemaRevision: CLAUDE_CODE_SETTINGS_SCHEMA_REVISION,
    hookEvents: CLAUDE_HOOK_EVENTS,
    toolMatchers: CLAUDE_TOOL_MATCHERS,
    evidence: CLAUDE_CODE_PINNED_SURFACE_EVIDENCE.fixture,
  },
]

export interface ParsedClaudeVersion {
  readonly raw: string
  readonly version: string
  readonly supported: boolean
}

const ANCHORED_VERSION_OUTPUT = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/

export function parseClaudeVersionOutput(raw: string): ParsedClaudeVersion {
  const trimmed = raw.trim()
  const match = ANCHORED_VERSION_OUTPUT.exec(trimmed)
  const version = match === null ? '' : `${match[1]}.${match[2]}.${match[3]}`
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

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/

export function parseClaudeCodeVersion(raw: string): string {
  const match = VERSION_PATTERN.exec(raw.trim())
  if (match === null) {
    throw new ClaudeCodeAdapterError(
      'UNSUPPORTED_VERSION',
      'Could not read a semantic Claude Code version',
      'Run "claude --version" and confirm the output begins with a major.minor.patch version and has no prerelease suffix.',
    )
  }
  return `${match[1]}.${match[2]}.${match[3]}`
}

export function assertClaudeVersionOverrideAllowed(
  override: string | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (override === undefined) return
  if (environment[TEST_HARNESS_ENV] === '1') return
  throw new ClaudeCodeAdapterError(
    'UNSUPPORTED_VERSION',
    'The --claude-version override is restricted to the explicit offline test harness',
    `Set ${TEST_HARNESS_ENV}=1 only inside a test harness, or run the pinned "claude --version" so the live version gate cannot be bypassed.`,
  )
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

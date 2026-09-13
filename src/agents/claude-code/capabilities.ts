import {
  CLAUDE_CODE_PINNED_SURFACE_EVIDENCE,
  CLAUDE_HOOK_EVENTS,
  CLAUDE_TOOL_MATCHERS,
  PINNED_CLAUDE_CODE_VERSION,
} from './version.js'

export interface CapabilityRow {
  readonly capability: string
  readonly status: 'covered' | 'uncovered'
  readonly detail: string
}

export const COVERED_CAPABILITIES: readonly CapabilityRow[] = [
  {
    capability: 'Bash tool calls via PreToolUse matcher "Bash"',
    status: 'covered',
    detail: `Proven for the pinned version only (single pinned surface: ${CLAUDE_HOOK_EVENTS.length} hook events, ${CLAUDE_TOOL_MATCHERS.length} tool matchers, evidence ${CLAUDE_CODE_PINNED_SURFACE_EVIDENCE.fixture}). The owned hook entrypoint reads the PreToolUse stdin JSON (tool_input.command), routes matching shell execution as a routing aid to the selected Session through "ocbox exec", and exits 2 to block when the payload is unreadable or no Session is usable. A routed call exports OCBOX_AGENT_ROUTED=1 and OCBOX_AGENT_ADAPTER=claude-code so a nested adapter-owned call is left local instead of recursing.`,
  },
  {
    capability: 'Source movement through explicit sync',
    status: 'covered',
    detail:
      'Local and remote trees move only through explicit "ocbox sync push/pull/diff"; the hook never moves source by itself.',
  },
]

export const UNCOVERED_CAPABILITIES: readonly CapabilityRow[] = [
  {
    capability: 'Edit / Write / NotebookEdit file mutation',
    status: 'uncovered',
    detail:
      'Executes locally in Claude Code; outside hook/permission coverage and never claimed as remote.',
  },
  {
    capability: 'Read / Glob / Grep / LSP local file access',
    status: 'uncovered',
    detail: 'Reads the local filesystem directly; the adapter cannot route or isolate these calls.',
  },
  {
    capability: 'WebFetch / WebSearch network access',
    status: 'uncovered',
    detail: 'Network egress is a local Claude Code capability; not routed through the Session.',
  },
  {
    capability: 'Bash when hooks are disabled or bypassed',
    status: 'uncovered',
    detail:
      'Runs such as --setting-sources exclusions, allowManagedHooksOnly locks, managed deny, or --dangerously-skip-permissions execute locally.',
  },
  {
    capability: 'PowerShell / Monitor / background tasks',
    status: 'uncovered',
    detail: 'Not matched by the owned "Bash" hook matcher; local execution remains possible.',
  },
  {
    capability: 'Agent / Task subagents and Skill execution',
    status: 'uncovered',
    detail:
      'Subagent toolchains run locally with their own tool access; not covered by this routing aid.',
  },
  {
    capability: 'MCP servers and IDE integrations',
    status: 'uncovered',
    detail:
      'External tools attached to Claude Code run outside the owned hook and permission rules.',
  },
]

export const CAPABILITY_MATRIX: readonly CapabilityRow[] = [
  ...COVERED_CAPABILITIES,
  ...UNCOVERED_CAPABILITIES,
]

export const ROUTING_AID_NOTICE =
  'This adapter is a reversible routing aid, not host isolation. Only the covered Bash row above is routed; every uncovered row stays local.'

export const PINNED_SURFACE_SUMMARY =
  `Claude Code ${PINNED_CLAUDE_CODE_VERSION}: single pinned surface with ` +
  `${CLAUDE_HOOK_EVENTS.length} hook events and ${CLAUDE_TOOL_MATCHERS.length} tool matchers ` +
  `(evidence ${CLAUDE_CODE_PINNED_SURFACE_EVIDENCE.fixture}).`

export {
  CLAUDE_HOOK_EVENTS as HOOK_EVENTS,
  CLAUDE_TOOL_MATCHERS as HOOKABLE_TOOL_NAMES,
} from './version.js'

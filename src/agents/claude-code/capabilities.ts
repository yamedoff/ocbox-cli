export interface CapabilityRow {
  readonly capability: string
  readonly status: 'covered' | 'uncovered'
  readonly detail: string
}

export const COVERED_CAPABILITIES: readonly CapabilityRow[] = [
  {
    capability: 'Bash tool calls via PreToolUse matcher "Bash"',
    status: 'covered',
    detail:
      'Proven for the pinned version only. Matching shell execution is routed as a routing aid to the selected Session through "ocbox exec"; missing session fails closed and blocks the call.',
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

export const HOOKABLE_TOOL_NAMES: readonly string[] = [
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'Read',
  'Glob',
  'Grep',
  'LSP',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'Skill',
  'TodoWrite',
  'Monitor',
  'PowerShell',
  'ExitPlanMode',
]

export const HOOK_EVENTS: readonly string[] = [
  'SessionStart',
  'Setup',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'MessageDisplay',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
]

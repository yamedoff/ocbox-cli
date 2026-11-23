import {
  CLAUDE_CODE_PINNED_SURFACE_EVIDENCE,
  CLAUDE_HOOK_EVENTS,
  CLAUDE_TOOL_MATCHERS,
  PINNED_CLAUDE_CODE_VERSION,
} from './version.js'
import {
  CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS,
  CLAUDE_CODE_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS,
  CLAUDE_CODE_HOOK_TIMEOUT_SECONDS,
} from './timeouts.js'

export interface CapabilityRow {
  readonly capability: string
  readonly status: 'covered' | 'uncovered'
  readonly detail: string
}

export const COVERED_CAPABILITIES: readonly CapabilityRow[] = [
  {
    capability: 'Bash tool calls via PreToolUse matcher "Bash"',
    status: 'covered',
    detail: `Proven for the pinned version only (single pinned surface: ${CLAUDE_HOOK_EVENTS.length} hook events, ${CLAUDE_TOOL_MATCHERS.length} tool matchers, evidence ${CLAUDE_CODE_PINNED_SURFACE_EVIDENCE.fixture}). The owned hook entrypoint reads the PreToolUse stdin JSON (tool_input.command) and routes matching shell execution as a routing aid to the selected Session through "ocbox exec". After a routed run the hook emits Claude Code's documented PreToolUse blocking decision ({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}) and exits 2, so the original local Bash call is explicitly denied and never executes a second time whether the remote command succeeded, exited nonzero (including 2), timed out, was cancelled, or failed after start. The command-hook timeout is fail-closed by construction: the installed handler pins timeout=${CLAUDE_CODE_HOOK_TIMEOUT_SECONDS} SECONDS (Claude Code's supported command-hook value) and the routed invocation passes --timeout ${CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS} MILLISECONDS, ${CLAUDE_CODE_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS}ms (${CLAUDE_CODE_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS / 1000}s) inside that deadline, so the remote runner returns a timeout outcome and the hook emits its blocking denial before Claude Code cancels the hook. Re-running setup reconciles the explicit timeout onto an owned hook installed before this contract. The denial reason is machine-readable: "ocbox-block[route] ... exit-code=<n>" reports the honest remote outcome, while an unroutable or unreadable covered call fails closed with "ocbox-block[guard]", so a legitimate remote exit 2 is never confused with the adapter's own block. A routed call exports OCBOX_AGENT_ROUTED=1 and OCBOX_AGENT_ADAPTER=claude-code so a nested adapter-owned call is left local instead of recursing. This is a code-level (offline) implementation of the documented contract, proven by unit tests, NOT a live Claude Code result; confirming the emitted timeout field and the cancel/decision race against the installed pinned binary (Claude Code ${PINNED_CLAUDE_CODE_VERSION}) remains a named AC9 live pin gate (see the timeout/cancel race row).`,
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
    capability: 'PreToolUse command-hook timeout/cancel race (live)',
    status: 'uncovered',
    detail: `Offline code orders both timers so a covered remote run returns a timeout outcome and the hook emits its deny before Claude Code cancels the hook (handler timeout=${CLAUDE_CODE_HOOK_TIMEOUT_SECONDS}s, ocbox exec --timeout=${CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS}ms, ${CLAUDE_CODE_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS}ms margin). This is not yet confirmed against an installed Claude Code ${PINNED_CLAUDE_CODE_VERSION}: if the installed binary ignores the emitted timeout field, applies different units, or cancels the hook at/before the bounded window, PreToolUse command hooks are fail-open and a covered command could still run locally a second time. Named AC9 live pin gate until run.`,
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

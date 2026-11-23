import {
  CODEX_HOOK_REMOTE_TIMEOUT_MILLISECONDS,
  CODEX_HOOK_TIMEOUT_EVIDENCE,
  CODEX_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS,
  CODEX_HOOK_TIMEOUT_SECONDS,
} from './timeouts.js'
import { PINNED_CODEX_VERSION } from './version.js'

export const CODEX_ADAPTER_NOTICE =
  'The Codex adapter is a routing aid, not host isolation and not a security boundary.'

export const COVERED_CAPABILITIES: readonly string[] = [
  'Codex Bash tool calls matching the owned PreToolUse hook (canonical `Bash` matcher) are mapped to the selected Session through `ocbox exec --session ... -- /bin/bash -lc <command>`',
  `the installed PreToolUse command hook emits an explicit timeout=${CODEX_HOOK_TIMEOUT_SECONDS} SECONDS (the pinned Codex command-handler deadline, ${CODEX_HOOK_TIMEOUT_EVIDENCE.field}/${CODEX_HOOK_TIMEOUT_EVIDENCE.units}) and the routed invocation passes --timeout ${CODEX_HOOK_REMOTE_TIMEOUT_MILLISECONDS} MILLISECONDS, ${CODEX_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS}ms (${CODEX_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS / 1000}s) inside that deadline, so the remote runner returns a timeout outcome and the hook emits its blocking denial before Codex cancels the hook`,
  'source movement only through an explicit `ocbox sync` invocation (the adapter never syncs implicitly)',
]

export const UNCOVERED_CAPABILITIES: readonly string[] = [
  'editor and file-application tools invoked outside hooks',
  'direct local shell execution outside the owned hook match',
  'direct network access from Codex tools',
  'MCP servers configured for Codex',
  'computer-use and browser execution',
  'background agents, daemons, and app-server sessions',
  'any future Codex tool or matcher not listed in the pinned fixture hook',
  `PreToolUse command-hook timeout/cancel race (live): the emitted timeout=${CODEX_HOOK_TIMEOUT_SECONDS}s and the paired ocbox exec --timeout=${CODEX_HOOK_REMOTE_TIMEOUT_MILLISECONDS}ms are a code-level (offline) contract. This is not yet confirmed against an installed Codex ${PINNED_CODEX_VERSION}: if the installed binary ignores the emitted timeout field, applies different units, or cancels the hook at/before the bounded window, a covered command could still run locally a second time. Named live pin gate until run.`,
]

export interface CodexCapabilityMatrix {
  readonly covered: readonly string[]
  readonly uncovered: readonly string[]
  readonly notice: string
}

export function capabilityMatrix(): CodexCapabilityMatrix {
  return {
    covered: COVERED_CAPABILITIES,
    uncovered: UNCOVERED_CAPABILITIES,
    notice: CODEX_ADAPTER_NOTICE,
  }
}

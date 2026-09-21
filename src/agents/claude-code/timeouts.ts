/**
 * Claude Code PreToolUse command-hook timeout contract (T11 final-review F7).
 *
 * Claude Code's hooks reference defines a hook handler's `timeout` field in
 * SECONDS (default 600 for `command`, `http`, and `mcp_tool` handlers). On
 * `PreToolUse`, a command hook that reaches its deadline is canceled: unlike an
 * Agent SDK callback hook, it does NOT block the tool call and its stdout
 * decision is discarded. A hook that outlives that deadline would therefore let
 * Claude Code run a covered Bash command locally a second time after `ocbox`
 * already ran it remotely.
 *
 * The adapter closes that fail-open window by making both timers explicit and
 * strictly ordered:
 *
 *   1. `CLAUDE_CODE_HOOK_TIMEOUT_SECONDS` is written onto the installed command
 *      handler, so Claude Code's cancel deadline is a known, supported value
 *      instead of an implicit default.
 *   2. `CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS` is passed to the routed
 *      `ocbox exec` invocation through `--timeout`, which is expressed in
 *      MILLISECONDS. It is strictly below the hook deadline by the documented
 *      safety margin, so the remote runner returns a `timeout` outcome (exit
 *      124) and the hook emits its documented `permissionDecision: "deny"` +
 *      exit 2 before Claude Code cancels the hook.
 *
 * These are code-level constants derived from the published hooks contract.
 * Confirming the emitted `timeout` field and the cancel/decision race against
 * an installed pinned binary remains a named AC9 live gate; see
 * `capabilities.ts`.
 */

/** Explicit Claude Code command-hook `timeout` in SECONDS (published default/supported value). */
export const CLAUDE_CODE_HOOK_TIMEOUT_SECONDS = 600

/** `ocbox exec --timeout` is milliseconds; a Claude Code hook `timeout` is seconds. */
export const MILLISECONDS_PER_SECOND = 1_000

/**
 * Time reserved inside the hook deadline for everything that is not the remote
 * command: Node/oclif process startup, reading the PreToolUse JSON from stdin,
 * resolving the selected Session/provider, streaming teardown, and writing the
 * JSON decision. The remote timeout sits this far below the hook deadline so
 * the blocking decision is always produced first.
 */
export const CLAUDE_CODE_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS = 30_000

/**
 * Bounded remote execution timeout (milliseconds) handed to `ocbox exec` as
 * `--timeout`. Derived from the hook deadline minus the safety margin and never
 * set directly, so the ordering invariant cannot drift.
 */
export const CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS =
  CLAUDE_CODE_HOOK_TIMEOUT_SECONDS * MILLISECONDS_PER_SECOND -
  CLAUDE_CODE_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS

/**
 * Fail-closed guard for the timer contract. Throws if the derived remote
 * timeout is not a positive value strictly inside the hook deadline, which can
 * only happen after an inconsistent edit to the constants above. Invoked at
 * module load so a broken contract surfaces immediately rather than silently
 * shipping a fail-open configuration.
 */
export function assertClaudeHookTimeoutOrdering(): void {
  const hookDeadlineMilliseconds = CLAUDE_CODE_HOOK_TIMEOUT_SECONDS * MILLISECONDS_PER_SECOND
  if (
    CLAUDE_CODE_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS <= 0 ||
    CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS <= 0 ||
    CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS >= hookDeadlineMilliseconds
  ) {
    throw new Error(
      'Claude Code hook timeout contract violated: the ocbox exec timeout must be a positive value strictly below the hook deadline',
    )
  }
}

assertClaudeHookTimeoutOrdering()

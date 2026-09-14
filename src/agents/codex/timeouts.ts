/**
 * Codex PreToolUse command-hook timeout contract (integrated-review D3).
 *
 * The pinned Codex hooks schema does express a command-handler deadline, so the
 * adapter does not need an "cannot express" fallback: the pinned contract
 * documents a `timeout` field on a `type: "command"` handler measured in
 * SECONDS, defaulting to `600` when omitted (only `SessionEnd`/`Interrupt` use
 * the short 1-second default with a 3-second cap), and the inline `config.toml`
 * example sets `timeout` on a `PreToolUse` handler. Evidence recorded in
 * `CODEX_HOOK_TIMEOUT_EVIDENCE`; a synchronous `PreToolUse` hook is the blocking
 * kind. A hook that outlives its deadline is discarded, so a routed remote run
 * must finish first.
 *
 * The adapter closes that fail-open window by making both timers explicit and
 * strictly ordered:
 *
 *   1. `CODEX_HOOK_TIMEOUT_SECONDS` is written onto the installed command
 *      handler, so Codex's cancel deadline is a known, supported value instead
 *      of an implicit default.
 *   2. `CODEX_HOOK_REMOTE_TIMEOUT_MILLISECONDS` is passed to the routed
 *      `ocbox exec` invocation through `--timeout`, expressed in MILLISECONDS.
 *      It is strictly below the hook deadline by the documented safety margin,
 *      so the remote runner returns a `timeout` outcome (exit 124) and the hook
 *      emits its documented PreToolUse deny before Codex cancels the hook.
 *
 * These are code-level constants derived from the published hooks contract.
 * Confirming the emitted `timeout` field and the cancel/decision race against an
 * installed pinned `codex-cli 0.153.4` remains a named live gate; see
 * `capabilities.ts`.
 */

/** Explicit Codex command-hook `timeout` in SECONDS (published supported value). */
export const CODEX_HOOK_TIMEOUT_SECONDS = 600

/** `ocbox exec --timeout` is milliseconds; a Codex hook `timeout` is seconds. */
export const MILLISECONDS_PER_SECOND = 1_000

/**
 * Time reserved inside the hook deadline for everything that is not the remote
 * command: Node/oclif process startup, reading the PreToolUse JSON from stdin,
 * resolving the selected Session/provider, streaming teardown, and writing the
 * JSON decision. The remote timeout sits this far below the hook deadline so the
 * blocking decision is always produced first.
 */
export const CODEX_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS = 30_000

/**
 * Bounded remote execution timeout (milliseconds) handed to `ocbox exec` as
 * `--timeout`. Derived from the hook deadline minus the safety margin and never
 * set directly, so the ordering invariant cannot drift.
 */
export const CODEX_HOOK_REMOTE_TIMEOUT_MILLISECONDS =
  CODEX_HOOK_TIMEOUT_SECONDS * MILLISECONDS_PER_SECOND -
  CODEX_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS

/**
 * Proof surface for the pinned deadline. The pinned hooks contract cannot be
 * captured into this repository (the upstream docs are not vendored), so the
 * documented facts are recorded here and asserted by `timeouts.test.ts`. If a
 * future pinned schema drops the handler `timeout`, the ordering assertion will
 * still hold but setup's capability diagnostic must change from "emitted" to
 * the safest supported bound.
 */
export const CODEX_HOOK_TIMEOUT_EVIDENCE = {
  contract: 'https://developers.openai.com/codex/hooks',
  handler: 'type = "command"',
  field: 'timeout',
  units: 'seconds',
  defaultSeconds: CODEX_HOOK_TIMEOUT_SECONDS,
  emittedSeconds: CODEX_HOOK_TIMEOUT_SECONDS,
  blockingEvent: 'PreToolUse',
} as const

/**
 * Fail-closed guard for the timer contract. Throws if the derived remote
 * timeout is not a positive value strictly inside the hook deadline, which can
 * only happen after an inconsistent edit to the constants above. Invoked at
 * module load so a broken contract surfaces immediately rather than silently
 * shipping a fail-open configuration.
 */
export function assertCodexHookTimeoutOrdering(): void {
  const hookDeadlineMilliseconds = CODEX_HOOK_TIMEOUT_SECONDS * MILLISECONDS_PER_SECOND
  if (
    CODEX_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS <= 0 ||
    CODEX_HOOK_REMOTE_TIMEOUT_MILLISECONDS <= 0 ||
    CODEX_HOOK_REMOTE_TIMEOUT_MILLISECONDS >= hookDeadlineMilliseconds
  ) {
    throw new Error(
      'Codex hook timeout contract violated: the ocbox exec timeout must be a positive value strictly below the hook deadline',
    )
  }
}

assertCodexHookTimeoutOrdering()

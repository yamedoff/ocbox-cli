import { parseExecArguments } from '../../execution/cli-arguments.js'
import {
  CODEX_HOOK_MATCHER_TOOL,
  CODEX_HOOK_PAYLOAD_REVISION,
  codexPreToolUseDenyDecision,
  parseCodexHookPayload,
} from './hook-contract.js'
import {
  ADAPTER_ID,
  ADAPTER_ID_ENV,
  buildHookCommand,
  HOOK_FAIL_CLOSED_EXIT_CODE,
  isOwnedHookCommand,
  planCodexHookRoute,
  RECURSION_GUARD_ENV,
  type HookEnvironment,
} from './hook-helper.js'
import { CODEX_HOOK_REMOTE_TIMEOUT_MILLISECONDS } from './timeouts.js'

export interface CodexRoutingHookOptions {
  readonly rawInput: string
  readonly sessionId: string | null
  readonly environment: HookEnvironment
  readonly invokeExec: (argv: readonly string[]) => Promise<number>
  readonly writeError: (message: string) => void
  readonly writeDecision: (json: string) => void
}

export interface CodexHookContractProof {
  readonly proven: boolean
  readonly revision: string
  readonly detail: string
}

const PROOF_SESSION_ID = '00000000-0000-4000-8000-000000000000' as const
const PROOF_COMMAND = 'printf ocbox-hook-contract' as const

/**
 * Executes the installed Codex hook entrypoint. Reads the pinned PreToolUse
 * JSON, applies fail-closed routing, and only then drives the selected Session
 * through the same `ocbox exec` grammar as the CLI. A routed call returns the
 * documented PreToolUse deny decision so Codex does not also run it locally.
 */
export async function runCodexRoutingHook(options: CodexRoutingHookOptions): Promise<number> {
  const parsed = parseCodexHookPayload(options.rawInput)
  if (!parsed.ok) {
    options.writeError(`ocbox codex router: ${parsed.reason}; failing closed`)
    return HOOK_FAIL_CLOSED_EXIT_CODE
  }
  const decision = planCodexHookRoute({
    payload: parsed.payload,
    sessionId: options.sessionId,
    environment: options.environment,
  })
  if (decision.action === 'allow-local') return 0
  if (decision.action === 'block' || decision.execArgv === null) {
    options.writeError(`ocbox codex router: ${decision.reason}`)
    return HOOK_FAIL_CLOSED_EXIT_CODE
  }
  let exitCode = 1
  try {
    exitCode = await options.invokeExec(decision.execArgv)
  } catch (error) {
    options.writeError(
      `ocbox codex router: routed execution failed (${error instanceof Error ? error.message : 'unknown error'}); failing closed`,
    )
  }
  options.writeDecision(
    codexPreToolUseDenyDecision(
      `covered Bash call routed to the selected Session through ocbox exec (exit ${exitCode}); local execution blocked`,
    ),
  )
  return 0
}

/**
 * Offline proof that the pinned hook contract is sufficient to install a
 * working hook: it parses a canonical PreToolUse payload, maps a covered `Bash`
 * call to the routed `ocbox exec` argv, confirms the recursion markers, and
 * validates that argv against the real execution grammar. Setup stays
 * fail-closed when this proof cannot be established.
 */
export function proveCodexHookContract(): CodexHookContractProof {
  const sample = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'codex-session',
    tool_name: CODEX_HOOK_MATCHER_TOOL,
    tool_input: { command: PROOF_COMMAND },
  })
  const parsed = parseCodexHookPayload(sample)
  if (!parsed.ok || parsed.payload.hookEventName !== 'PreToolUse') {
    return { proven: false, revision: CODEX_HOOK_PAYLOAD_REVISION, detail: 'payload-schema' }
  }
  const installedCommand = buildHookCommand({ sessionId: PROOF_SESSION_ID })
  if (!isOwnedHookCommand(installedCommand) || !installedCommand.includes(PROOF_SESSION_ID)) {
    return { proven: false, revision: CODEX_HOOK_PAYLOAD_REVISION, detail: 'installed-command' }
  }
  const decision = planCodexHookRoute({
    payload: parsed.payload,
    sessionId: PROOF_SESSION_ID,
    environment: {},
  })
  if (decision.action !== 'route' || decision.execArgv === null) {
    return { proven: false, revision: CODEX_HOOK_PAYLOAD_REVISION, detail: 'routing-decision' }
  }
  if (
    !decision.execArgv.includes(`${RECURSION_GUARD_ENV}=1`) ||
    !decision.execArgv.includes(`${ADAPTER_ID_ENV}=${ADAPTER_ID}`)
  ) {
    return { proven: false, revision: CODEX_HOOK_PAYLOAD_REVISION, detail: 'recursion-markers' }
  }
  if (
    !decision.execArgv.includes('--timeout') ||
    !decision.execArgv.includes(String(CODEX_HOOK_REMOTE_TIMEOUT_MILLISECONDS))
  ) {
    return { proven: false, revision: CODEX_HOOK_PAYLOAD_REVISION, detail: 'timeout-ordering' }
  }
  try {
    const grammar = parseExecArguments(decision.execArgv.slice(1))
    if (grammar.sessionId !== PROOF_SESSION_ID) {
      return { proven: false, revision: CODEX_HOOK_PAYLOAD_REVISION, detail: 'session-grammar' }
    }
    if (grammar.command.mode !== 'argv') {
      return { proven: false, revision: CODEX_HOOK_PAYLOAD_REVISION, detail: 'argv-grammar' }
    }
    const argv = grammar.command.argv
    if (argv[argv.length - 1] !== PROOF_COMMAND) {
      return { proven: false, revision: CODEX_HOOK_PAYLOAD_REVISION, detail: 'command-grammar' }
    }
  } catch {
    return { proven: false, revision: CODEX_HOOK_PAYLOAD_REVISION, detail: 'exec-grammar' }
  }
  return { proven: true, revision: CODEX_HOOK_PAYLOAD_REVISION, detail: 'ok' }
}

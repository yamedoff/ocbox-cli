import { decideRouting, recursionGuardArgs } from './routing.js'

export interface ClaudeHookInput {
  readonly toolName: string
  readonly command: string
}

/**
 * Reads the Claude Code hook contract: a JSON object on stdin with `tool_name`
 * and `tool_input.command`. Anything else is refused so the caller can fail
 * closed instead of letting a covered Bash call run locally.
 */
export function parseClaudeHookInput(raw: string): ClaudeHookInput | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as { readonly tool_name?: unknown; readonly tool_input?: unknown }
  const toolName = record.tool_name
  if (typeof toolName !== 'string' || toolName.length === 0) return null
  const toolInput = record.tool_input
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) return null
  const command = (toolInput as { readonly command?: unknown }).command
  if (typeof command !== 'string') return null
  return { toolName, command }
}

/** The terminal outcome kinds the hook may report for a routed invocation. */
export type ClaudeHookOutcome = 'remote_result' | 'timeout' | 'cancelled' | 'infrastructure_error'

/**
 * Structured result of a routed `ocbox exec` invocation. `started: false` is the
 * adapter's own pre-start guard (unroutable Session, invalid exec grammar, or
 * any failure before the remote process begins); `started: true` is a real
 * remote outcome whose exit code must be reported, not swallowed.
 */
export interface ClaudeHookExecResult {
  readonly started: boolean
  readonly exitCode: number
  readonly outcome: ClaudeHookOutcome
}

export const HOOK_DENY_SOURCE_GUARD = 'guard' as const
export const HOOK_DENY_SOURCE_ROUTE = 'route' as const
export type ClaudeHookDenySource = typeof HOOK_DENY_SOURCE_GUARD | typeof HOOK_DENY_SOURCE_ROUTE

/**
 * The documented Claude Code PreToolUse blocking decision. Denying the original
 * local tool call is what stops a covered Bash command from running a second
 * time on the host after `ocbox` already ran it in the Session.
 */
export interface ClaudeHookDenyDecision {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'PreToolUse'
    readonly permissionDecision: 'deny'
    readonly permissionDecisionReason: string
  }
}

export function buildClaudeDenyDecision(reason: string): ClaudeHookDenyDecision {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

/**
 * Machine-readable denial reasons. Both the adapter's own pre-start guard and a
 * routed remote outcome block the local copy, so the discriminator lives inside
 * the documented `permissionDecisionReason` field: `ocbox-block[guard]` for a
 * fail-closed pre-start decision, and `ocbox-block[route]` (with `exit-code=`)
 * for a completed remote run. A legitimate remote exit 2 therefore never looks
 * like the adapter's own block mechanism.
 */
export function guardDenyReason(message: string): string {
  return `ocbox-block[${HOOK_DENY_SOURCE_GUARD}] ${message}`
}

export function routeDenyReason(result: ClaudeHookExecResult): string {
  return (
    `ocbox-block[${HOOK_DENY_SOURCE_ROUTE}] remote command outcome=${result.outcome} ` +
    `exit-code=${result.exitCode}; local Bash execution denied so the covered command does not run twice`
  )
}

export interface ClaudeRoutingHookOptions {
  readonly rawInput: string
  readonly sessionId: string | null
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly invokeExec: (argv: readonly string[]) => Promise<ClaudeHookExecResult>
  readonly writeError: (message: string) => void
  readonly writeDecision: (decision: ClaudeHookDenyDecision) => void
}

function emitDeny(options: ClaudeRoutingHookOptions, reason: string): number {
  options.writeError(reason)
  options.writeDecision(buildClaudeDenyDecision(reason))
  return 2
}

/**
 * Executes the emitted hook command body and always returns a blocking decision
 * for a covered Bash call. Exit 0 is reserved for uncovered tools and
 * recursion-guarded owned invocations (never contacted a Session); every routed
 * or unroutable covered call writes a documented `permissionDecision: "deny"`
 * JSON object and exits 2, so Claude Code never runs the local Bash copy,
 * whether the remote command succeeded, exited nonzero, or failed after start.
 */
export async function runClaudeRoutingHook(options: ClaudeRoutingHookOptions): Promise<number> {
  const payload = parseClaudeHookInput(options.rawInput)
  if (payload === null) {
    return emitDeny(
      options,
      guardDenyReason('could not read tool_input.command from hook stdin; failing closed'),
    )
  }
  const decision = decideRouting({
    toolName: payload.toolName,
    command: payload.command,
    sessionId: options.sessionId,
    environment: options.environment,
  })
  if (decision.action === 'block') {
    return emitDeny(options, guardDenyReason(decision.reason))
  }
  if (decision.action === 'allow-local' || decision.execArgv === null) return 0
  let result: ClaudeHookExecResult
  try {
    result = await options.invokeExec([...decision.execArgv, ...recursionGuardArgs()])
  } catch {
    return emitDeny(
      options,
      guardDenyReason('routed execution failed before reporting an outcome; failing closed'),
    )
  }
  if (!result.started) {
    return emitDeny(
      options,
      guardDenyReason(
        `routed execution could not start (exit-code=${result.exitCode}); failing closed`,
      ),
    )
  }
  return emitDeny(options, routeDenyReason(result))
}

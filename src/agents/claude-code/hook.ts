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

export interface ClaudeRoutingHookOptions {
  readonly rawInput: string
  readonly sessionId: string | null
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly invokeExec: (argv: readonly string[]) => Promise<number>
  readonly writeError: (message: string) => void
}

/**
 * Executes the emitted hook command body. Returns the process exit code: 0 lets
 * Claude Code proceed locally (uncovered or recursion-guarded), 2 blocks a
 * covered call without a usable Session or with an unreadable hook payload, and
 * a routed call returns the remote execution exit code. The routed argv sets
 * the recursion markers so a nested adapter refuses to route again.
 */
export async function runClaudeRoutingHook(options: ClaudeRoutingHookOptions): Promise<number> {
  const payload = parseClaudeHookInput(options.rawInput)
  if (payload === null) {
    options.writeError(
      'ocbox claude-code router: could not read tool_input.command from hook stdin; failing closed',
    )
    return 2
  }
  const decision = decideRouting({
    toolName: payload.toolName,
    command: payload.command,
    sessionId: options.sessionId,
    environment: options.environment,
  })
  if (decision.action === 'block') {
    options.writeError(`ocbox claude-code router: ${decision.reason}`)
    return 2
  }
  if (decision.action === 'allow-local' || decision.execArgv === null) return 0
  return options.invokeExec([...decision.execArgv, ...recursionGuardArgs()])
}

import { OWNED_HOOK_COMMAND_FRAGMENT } from './settings-model.js'
import { CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS } from './timeouts.js'

export const RECURSION_GUARD_ENV = 'OCBOX_AGENT_ROUTED' as const
export const ADAPTER_ID_ENV = 'OCBOX_AGENT_ADAPTER' as const
export const ADAPTER_ID = 'claude-code' as const

export interface RoutingDecision {
  readonly action: 'route' | 'allow-local' | 'block'
  readonly reason: string
  readonly execArgv: readonly string[] | null
}

export interface RoutingInput {
  readonly toolName: string
  readonly command: string
  readonly sessionId: string | null
  readonly environment: Readonly<Record<string, string | undefined>>
}

/**
 * The installed hook command is a real `ocbox` entrypoint. It reads the Claude
 * Code PreToolUse stdin JSON, applies routing, and fails closed with exit 2.
 *
 * Every hook the adapter installs must be detectable by `parseOwnedHookCommand`
 * so `doctor` can report it and `remove` can delete it. A Session whose text
 * contains whitespace (padded, internal, control) would embed an ambiguous
 * `--session` token that the anchored parser can never recover, stranding an
 * unremovable hook. The build is therefore gated by a build/parse round-trip:
 * callers must pass the canonical value, and anything that cannot round-trip is
 * refused before it reaches a settings file.
 */
export function buildHookCommand(sessionId: string | null): string {
  const sessionFragment = sessionId === null ? '' : ` --session ${sessionId}`
  const command = `${OWNED_HOOK_COMMAND_FRAGMENT}${sessionFragment}`
  const parsed = parseOwnedHookCommand(command)
  if (parsed === null || parsed.sessionId !== sessionId) {
    throw new Error(
      `Refusing to install an undetectable owned hook: Session ${JSON.stringify(
        sessionId,
      )} does not round-trip through the hook command grammar`,
    )
  }
  return command
}

/**
 * `ocbox exec` settings that mark a routed execution environment as adapter
 * owned, so a nested Claude Code inside the Session leaves Bash local instead
 * of routing back out (unbounded recursion guard).
 */
export function recursionGuardArgs(): readonly string[] {
  return ['--env', `${RECURSION_GUARD_ENV}=1`, '--env', `${ADAPTER_ID_ENV}=${ADAPTER_ID}`]
}

/**
 * Exact-shape matcher for the adapter-owned router command. Ownership is never
 * inferred from substrings: a user command that merely mentions `ocbox agent
 * hook claude-code` as a substring must still survive `remove` untouched unless
 * it matches the exact emitted shape. The Session varies, so the only variable
 * segment is the optional `--session <id>` token.
 */
const OWNED_HOOK_COMMAND_PATTERN = /^ocbox agent hook claude-code(?: --session (\S+))?$/

export function parseOwnedHookCommand(
  command: unknown,
): { readonly sessionId: string | null } | null {
  if (typeof command !== 'string') return null
  const match = OWNED_HOOK_COMMAND_PATTERN.exec(command)
  if (match === null) return null
  return { sessionId: match[1] ?? null }
}

export function isOwnedHookCommand(command: unknown): boolean {
  return parseOwnedHookCommand(command) !== null
}

export function decideRouting(input: RoutingInput): RoutingDecision {
  const routed = input.environment[RECURSION_GUARD_ENV]
  const adapter = input.environment[ADAPTER_ID_ENV]
  if (routed === '1' && adapter === ADAPTER_ID) {
    return {
      action: 'allow-local',
      reason: 'adapter-owned ocbox invocation; recursion guard engaged',
      execArgv: null,
    }
  }
  if (input.toolName !== 'Bash') {
    return {
      action: 'allow-local',
      reason: `tool "${input.toolName}" is outside owned Bash coverage; left local honestly`,
      execArgv: null,
    }
  }
  // Anti-recursion recognizes only the exact owned invocation grammar, never a
  // substring. A covered command that merely *contains* the owned fragment (or
  // the `ocbox`/adapter marker text) is a repository-controllable bypass and
  // must still route; only a command that `parseOwnedHookCommand` recovers
  // exactly is left local. Genuine nested adapter-owned calls are covered by the
  // environment recursion markers checked above.
  if (isOwnedHookCommand(input.command)) {
    return {
      action: 'allow-local',
      reason: 'exact adapter-owned router invocation; not re-routed',
      execArgv: null,
    }
  }
  if (input.sessionId === null || input.sessionId.length === 0) {
    return {
      action: 'block',
      reason:
        'covered Bash call without a usable selected Session; failing closed (exit 2) instead of running locally',
      execArgv: null,
    }
  }
  return {
    action: 'route',
    reason: `covered Bash call routed to selected Session through ocbox exec; source moves only via explicit ocbox sync`,
    // The remote run is bounded strictly below the installed hook `timeout` so
    // the runner returns a timeout outcome and the hook emits its blocking
    // denial before Claude Code cancels the hook (F7).
    execArgv: [
      'exec',
      '--session',
      input.sessionId,
      '--timeout',
      String(CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS),
      '--shell',
      input.command,
    ],
  }
}

import {
  CODEX_HOOK_MATCHER_TOOL,
  type CodexHookPayload,
  codexShellCommandToArgv,
} from './hook-contract.js'
import { parseOwnedCodexCommand } from './ownership.js'

/**
 * Explicit routed environment markers. A routed `ocbox exec` exports these so a
 * nested Codex inside the Session leaves covered calls local instead of routing
 * them out again.
 */
export const RECURSION_GUARD_ENV = 'OCBOX_CODEX_ADAPTER_ACTIVE' as const

export const ADAPTER_ID_ENV = 'OCBOX_CODEX_ADAPTER' as const

export const ADAPTER_ID = 'codex' as const

export const SESSION_ENV = 'OCBOX_CODEX_SESSION_ID' as const

export const HOOK_FAIL_CLOSED_EXIT_CODE = 2 as const

export const OWNED_HOOK_COMMAND_FRAGMENT = 'agent hook codex' as const

export const OWNED_EXEC_FRAGMENT = 'ocbox exec' as const

export type HookEnvironment = Readonly<Record<string, string | undefined>>

export function isRecursionGuardActive(environment: HookEnvironment): boolean {
  return environment[RECURSION_GUARD_ENV] === '1' || environment[ADAPTER_ID_ENV] === ADAPTER_ID
}

/**
 * Options that mark a routed execution environment as adapter owned, so a
 * nested Codex adapter cannot recursively route the same call.
 */
export function recursionGuardArgs(): readonly string[] {
  return ['--env', `${RECURSION_GUARD_ENV}=1`, '--env', `${ADAPTER_ID_ENV}=${ADAPTER_ID}`]
}

export interface HookCommandOptions {
  readonly sessionId: string
  readonly ocboxBin?: string | undefined
}

/** The real `ocbox` entrypoint installed as the owned Codex hook command. */
export function buildHookArgv(options: HookCommandOptions): readonly string[] {
  return [options.ocboxBin ?? 'ocbox', 'agent', 'hook', 'codex', '--session', options.sessionId]
}

export function buildHookCommand(options: HookCommandOptions): string {
  return buildHookArgv(options).join(' ')
}

/**
 * Anti-recursion ownership check. This delegates to the single anchored
 * grammar in `ownership.ts`: only an exact ocbox-owned invocation (the
 * installed hook entrypoint or the legacy exec shape) suppresses re-routing.
 * A repository-controlled lookalike that merely contains `ocbox exec` or
 * `agent hook codex` is not owned and must still route.
 */
export function isOwnedHookCommand(command: string): boolean {
  return parseOwnedCodexCommand(command) !== null
}

export interface RoutedExecInput {
  readonly sessionId: string
  readonly command: string
}

/**
 * Maps covered shell command data to `ocbox exec --session ... -- <argv>`.
 * The recursion markers travel as `--env` options before the `--` terminator so
 * the structured argv itself is never rewritten.
 */
export function buildRoutedExecArgv(input: RoutedExecInput): readonly string[] {
  return [
    'exec',
    '--session',
    input.sessionId,
    ...recursionGuardArgs(),
    '--env',
    `${SESSION_ENV}=${input.sessionId}`,
    '--',
    ...codexShellCommandToArgv(input.command),
  ]
}

export type CodexRouteAction = 'allow-local' | 'route' | 'block'

export interface CodexRouteDecision {
  readonly action: CodexRouteAction
  readonly reason: string
  readonly execArgv: readonly string[] | null
}

export interface CodexRouteInput {
  readonly payload: CodexHookPayload | null
  readonly sessionId: string | null | undefined
  readonly environment: HookEnvironment
}

function allowLocal(reason: string): CodexRouteDecision {
  return { action: 'allow-local', reason, execArgv: null }
}

function block(reason: string): CodexRouteDecision {
  return { action: 'block', reason, execArgv: null }
}

/**
 * Pure routing decision for the installed hook entrypoint. Covered `Bash` calls
 * route through the selected Session; a covered call with no usable Session or
 * unreadable command fails closed (blocks) instead of running locally.
 */
export function planCodexHookRoute(input: CodexRouteInput): CodexRouteDecision {
  const { payload } = input
  if (payload === null) return block('unreadable hook payload; failing closed')
  if (payload.hookEventName !== 'PreToolUse') {
    return allowLocal(`hook event ${payload.hookEventName} is outside PreToolUse coverage`)
  }
  if (isRecursionGuardActive(input.environment)) {
    return allowLocal('adapter-owned invocation; recursion guard engaged')
  }
  if (payload.toolName !== CODEX_HOOK_MATCHER_TOOL) {
    return allowLocal(`tool ${payload.toolName} is outside owned shell coverage`)
  }
  if (payload.command === null) {
    return block('covered Bash call with unreadable tool_input.command; failing closed')
  }
  if (isOwnedHookCommand(payload.command)) {
    return allowLocal('adapter-owned command; not re-routed')
  }
  if (input.sessionId === null || input.sessionId === undefined || input.sessionId.length === 0) {
    return block('covered Bash call without a usable selected Session; failing closed')
  }
  return {
    action: 'route',
    reason:
      'covered Bash call routed to the selected Session through ocbox exec; source moves only via explicit ocbox sync',
    execArgv: buildRoutedExecArgv({ sessionId: input.sessionId, command: payload.command }),
  }
}

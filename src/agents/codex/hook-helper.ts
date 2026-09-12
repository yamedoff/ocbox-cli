export const RECURSION_GUARD_ENV = 'OCBOX_CODEX_ADAPTER_ACTIVE' as const

export const SESSION_ENV = 'OCBOX_CODEX_SESSION_ID' as const

export const HOOK_OWNED_ID = 'ocbox-codex-routing-v1' as const

export const HOOK_FAIL_CLOSED_EXIT_CODE = 97 as const

export type HookEnvironment = Readonly<Record<string, string | undefined>>

export function isRecursionGuardActive(environment: HookEnvironment): boolean {
  return environment[RECURSION_GUARD_ENV] === '1'
}

export interface HookCommandOptions {
  readonly sessionId: string
  readonly ocboxBin?: string | undefined
}

export function buildHookArgv(options: HookCommandOptions): readonly string[] {
  return [options.ocboxBin ?? 'ocbox', 'exec', '--session', options.sessionId, '--']
}

function quotePosixWord(value: string): string {
  return `'${value.replaceAll(`'`, `'"'"'`)}'`
}

export function buildHookShellCommand(options: HookCommandOptions): string {
  return buildHookArgv(options).map(quotePosixWord).join(' ')
}

export function buildHookScript(options: HookCommandOptions): string {
  const routed = `${buildHookShellCommand(options)} "$@"`
  return [
    '#!/bin/sh',
    'set -eu',
    `if [ "\${${RECURSION_GUARD_ENV}:-}" = "1" ]; then`,
    '  exit 0',
    'fi',
    `if [ -z "\${${SESSION_ENV}:-}" ]; then`,
    '  echo "ocbox-codex: no usable Session for remote routing; failing closed" >&2',
    '  exit 97',
    'fi',
    `export ${RECURSION_GUARD_ENV}=1`,
    `exec ${routed}`,
    '',
  ].join('\n')
}

export function hookRouteDecision(
  environment: HookEnvironment,
  sessionId: string | null | undefined,
): { readonly route: boolean; readonly reason: string } {
  if (isRecursionGuardActive(environment)) {
    return { route: false, reason: 'recursion-guard-active' }
  }
  if (sessionId === null || sessionId === undefined || sessionId.length === 0) {
    return { route: false, reason: 'missing-session-fail-closed' }
  }
  return { route: true, reason: 'covered-shell-call' }
}

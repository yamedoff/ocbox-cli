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

export function buildHookCommand(sessionId: string | null): string {
  const sessionFragment = sessionId === null ? '' : ` --session ${sessionId}`
  return `ocbox exec${sessionFragment} --shell "$CLAUDE_TOOL_COMMAND" # ocbox-claude-code router; requires OCBOX_AGENT_ROUTED=1 to prevent loops`
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
  if (input.command.includes('ocbox exec') && input.command.includes('ocbox-claude-code')) {
    return {
      action: 'allow-local',
      reason: 'adapter-owned router invocation; not re-routed',
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
    execArgv: ['exec', '--session', input.sessionId, '--shell', input.command],
  }
}

export function hookRouterShellPrelude(): string {
  return [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in emitted hook script
    'if [ "${OCBOX_AGENT_ROUTED:-}" = "1" ] && [ "${OCBOX_AGENT_ADAPTER:-}" = "claude-code" ]; then',
    '  exit 0',
    'fi',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in emitted hook script
    'if [ -z "${OCBOX_SESSION_ID:-}" ]; then',
    '  echo "ocbox claude-code router: no usable Session; failing closed" >&2',
    '  exit 2',
    'fi',
  ].join('\n')
}

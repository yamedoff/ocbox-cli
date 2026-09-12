export const CODEX_ADAPTER_NOTICE =
  'The Codex adapter is a routing aid, not host isolation and not a security boundary.'

export const COVERED_CAPABILITIES: readonly string[] = [
  'shell tool calls matching the owned fixture hook (routed through the selected Session via `ocbox exec`)',
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

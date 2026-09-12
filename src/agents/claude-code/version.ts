export const PINNED_CLAUDE_CODE_VERSION = '2.0.51' as const

export interface ParsedClaudeVersion {
  readonly raw: string
  readonly version: string
  readonly supported: boolean
}

export function parseClaudeVersionOutput(raw: string): ParsedClaudeVersion {
  const trimmed = raw.trim()
  const match = /(\d+\.\d+\.\d+)/.exec(trimmed)
  const version = match?.[1] ?? ''
  return {
    raw: trimmed,
    version,
    supported: version === PINNED_CLAUDE_CODE_VERSION,
  }
}

export interface VersionGateResult {
  readonly supported: boolean
  readonly installed: string
  readonly pinned: typeof PINNED_CLAUDE_CODE_VERSION
  readonly remediation: string
}

export function gateClaudeVersion(raw: string): VersionGateResult {
  const parsed = parseClaudeVersionOutput(raw)
  const remediation =
    `Unsupported Claude Code version "${parsed.version || parsed.raw}". ` +
    `This adapter is pinned to Claude Code ${PINNED_CLAUDE_CODE_VERSION} ` +
    `(verified hooks key, PreToolUse matcher, and permissions schema). ` +
    `Install ${PINNED_CLAUDE_CODE_VERSION}, then re-run doctor. ` +
    `Setup refuses to guess newer or older schemas and fails closed.`
  return {
    supported: parsed.supported,
    installed: parsed.version === '' ? parsed.raw : parsed.version,
    pinned: PINNED_CLAUDE_CODE_VERSION,
    remediation,
  }
}

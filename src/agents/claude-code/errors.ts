export type ClaudeCodeAdapterErrorCode =
  | 'UNSUPPORTED_VERSION'
  | 'UNSUPPORTED_SCHEMA'
  | 'CORRUPT_SETTINGS'
  | 'MANAGED_POLICY_PROTECTED'
  | 'DRIFT_CONFLICT'
  | 'ROLLBACK_FAILED'

export class ClaudeCodeAdapterError extends Error {
  readonly code: ClaudeCodeAdapterErrorCode
  readonly remediation: string | null

  constructor(
    code: ClaudeCodeAdapterErrorCode,
    message: string,
    remediation: string | null = null,
  ) {
    super(message)
    this.name = 'ClaudeCodeAdapterError'
    this.code = code
    this.remediation = remediation
  }
}

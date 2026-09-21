import type { CodexJsonValue } from './document.js'

export const CODEX_ADAPTER_ERROR_CODES = [
  'CODEX_VERSION_UNSUPPORTED',
  'CODEX_SCHEMA_UNSUPPORTED',
  'CODEX_CONFIG_INVALID',
  'CODEX_HOOKS_INVALID',
  'CODEX_MANIFEST_INVALID',
  'CODEX_PROJECT_UNTRUSTED',
  'CODEX_APPLY_FAILED',
  'CODEX_ROLLBACK_FAILED',
  'CODEX_UNSAFE_PATH',
] as const

export type CodexAdapterErrorCode = (typeof CODEX_ADAPTER_ERROR_CODES)[number]

export interface CodexAdapterErrorInput {
  readonly code: CodexAdapterErrorCode
  readonly message: string
  readonly remediation: string
  readonly details?: Readonly<Record<string, CodexJsonValue>>
}

export class CodexAdapterError extends Error {
  readonly code: CodexAdapterErrorCode
  readonly remediation: string
  readonly details?: Readonly<Record<string, CodexJsonValue>>

  constructor(input: CodexAdapterErrorInput) {
    super(input.message)
    this.name = 'CodexAdapterError'
    this.code = input.code
    this.remediation = input.remediation
    if (input.details !== undefined) this.details = input.details
  }

  toJSON(): {
    readonly code: CodexAdapterErrorCode
    readonly message: string
    readonly remediation: string
    readonly details?: Readonly<Record<string, CodexJsonValue>>
  } {
    return {
      code: this.code,
      message: this.message,
      remediation: this.remediation,
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }
}

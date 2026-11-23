import { z } from 'zod'

export const OCBOX_ERROR_CODES = [
  'AUTH_REQUIRED',
  'AUTH_EXPIRED',
  'AUTH_FORBIDDEN',
  'CONFIG_INVALID',
  'PROJECT_NOT_FOUND',
  'ENVIRONMENT_NOT_FOUND',
  'PROVIDER_AUTH',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_QUOTA',
  'PROVIDER_CAPACITY',
  'PROVIDER_REGION_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'INVALID_SPEC',
  'CAPABILITY_UNSUPPORTED',
  'SANDBOX_NOT_FOUND',
  'SANDBOX_NOT_READY',
  'INVALID_STATE',
  'OPERATION_CONFLICT',
  'OPERATION_TIMEOUT',
  'OPERATION_CANCELLED',
  'SYNC_CONFLICT',
  'SYNC_TOO_LARGE',
  'SYNC_INTEGRITY',
  'SYNC_FAILED',
  'NETWORK_POLICY_DENIED',
  'PREVIEW_UNAVAILABLE',
  'PAYMENT_REQUIRED',
  'INSUFFICIENT_CREDITS',
  'USAGE_LIMIT',
  'BILLING_RECONCILIATION',
  'INTERNAL',
] as const

export const OcboxErrorCodeSchema = z.enum(OCBOX_ERROR_CODES)
export type OcboxErrorCode = z.infer<typeof OcboxErrorCodeSchema>

export interface OcboxErrorDefinition {
  readonly retryable: boolean
}

export const OCBOX_ERROR_REGISTRY = {
  AUTH_REQUIRED: { retryable: false },
  AUTH_EXPIRED: { retryable: false },
  AUTH_FORBIDDEN: { retryable: false },
  CONFIG_INVALID: { retryable: false },
  PROJECT_NOT_FOUND: { retryable: false },
  ENVIRONMENT_NOT_FOUND: { retryable: false },
  PROVIDER_AUTH: { retryable: false },
  PROVIDER_UNAVAILABLE: { retryable: true },
  PROVIDER_RATE_LIMIT: { retryable: true },
  PROVIDER_QUOTA: { retryable: false },
  PROVIDER_CAPACITY: { retryable: true },
  PROVIDER_REGION_UNAVAILABLE: { retryable: false },
  PROVIDER_TIMEOUT: { retryable: true },
  INVALID_SPEC: { retryable: false },
  CAPABILITY_UNSUPPORTED: { retryable: false },
  SANDBOX_NOT_FOUND: { retryable: false },
  SANDBOX_NOT_READY: { retryable: true },
  INVALID_STATE: { retryable: false },
  OPERATION_CONFLICT: { retryable: true },
  OPERATION_TIMEOUT: { retryable: true },
  OPERATION_CANCELLED: { retryable: false },
  SYNC_CONFLICT: { retryable: false },
  SYNC_TOO_LARGE: { retryable: false },
  SYNC_INTEGRITY: { retryable: true },
  SYNC_FAILED: { retryable: true },
  NETWORK_POLICY_DENIED: { retryable: false },
  PREVIEW_UNAVAILABLE: { retryable: true },
  PAYMENT_REQUIRED: { retryable: false },
  INSUFFICIENT_CREDITS: { retryable: false },
  USAGE_LIMIT: { retryable: false },
  BILLING_RECONCILIATION: { retryable: true },
  INTERNAL: { retryable: false },
} as const satisfies Readonly<Record<OcboxErrorCode, OcboxErrorDefinition>>

export function assertNever(value: never): never {
  throw new TypeError(`Unexpected exhaustive value: ${String(value)}`)
}

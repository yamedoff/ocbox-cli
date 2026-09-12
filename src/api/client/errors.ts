import { newRequestId } from '../../auth/errors.js'
import { RequestIdSchema, type RequestId } from '../../domain/ids.js'
import { OcboxError, type OcboxErrorCode } from '../../errors/index.js'

export interface ApiFailureInput {
  readonly status: number
  readonly serverCode?: string | undefined
  readonly serverMessage?: string | undefined
  readonly requestId?: string | null | undefined
  readonly retryAfterSeconds?: number | null | undefined
  readonly operation?: string | undefined
}

/**
 * Preserves the server request ID when it already meets the public ID shape;
 * otherwise mints a local one. Server IDs are opaque strings, while the
 * public catalogue requires UUID/ULID request IDs.
 */
export function toRequestId(requestId: string | null | undefined): RequestId {
  if (typeof requestId === 'string') {
    const parsed = RequestIdSchema.safeParse(requestId)
    if (parsed.success) return parsed.data
  }
  return newRequestId()
}

function safeRequestId(requestId: string | null | undefined): RequestId {
  return toRequestId(requestId)
}

function normalizedCode(code: string | undefined): string {
  return (code ?? '').trim().toUpperCase()
}

function detailsFor(operation: string | undefined): { operation: string } | undefined {
  return operation === undefined ? undefined : { operation }
}

/**
 * Maps hosted HTTP/envelope failures to the stable public catalogue.
 * Request IDs are preserved from the `x-request-id` header or the envelope;
 * server codes survive as `providerCode` so the mapping is lossless.
 */
export function mapApiFailureToOcboxError(input: ApiFailureInput): OcboxError {
  const requestId = safeRequestId(input.requestId)
  const code = normalizedCode(input.serverCode)
  const status = input.status
  const details = detailsFor(input.operation)

  const withProviderCode = (errorCode: OcboxErrorCode, message: string): OcboxError =>
    new OcboxError({
      code: errorCode,
      message,
      requestId,
      ...(code === '' ? {} : { providerCode: code.slice(0, 128) }),
      ...(details === undefined ? {} : { details }),
    })

  if (code === 'RATE_LIMITED' || status === 429) {
    return withProviderCode('PROVIDER_RATE_LIMIT', 'The hosted service rate limit was reached')
  }
  if (code === 'SERVICE_UNAVAILABLE' || status === 503) {
    return withProviderCode('PROVIDER_UNAVAILABLE', 'The hosted service is temporarily unavailable')
  }
  if (status === 401 || code === 'UNAUTHENTICATED' || code === 'INVALID_CLIENT') {
    return withProviderCode('AUTH_REQUIRED', 'Authentication is required; run `ocbox auth login`')
  }
  if (code === 'INVALID_GRANT') {
    return withProviderCode('AUTH_REQUIRED', 'Authentication is required; run `ocbox auth login`')
  }
  if (status === 403 || code === 'FORBIDDEN' || code === 'CSRF_TOKEN_INVALID') {
    return withProviderCode(
      'AUTH_FORBIDDEN',
      'The hosted service refused the authenticated request',
    )
  }
  if (status === 404) {
    return withProviderCode('PROJECT_NOT_FOUND', 'The requested hosted resource was not found')
  }
  if (
    status === 409 ||
    code === 'IDEMPOTENCY_CONFLICT' ||
    code === 'IDEMPOTENCY_IN_PROGRESS' ||
    code === 'SESSION_STATE_CONFLICT' ||
    code === 'OPERATION_NOT_CANCELLABLE' ||
    code === 'EXECUTION_NOT_CANCELLABLE' ||
    code === 'EXECUTION_NOT_COMPLETE' ||
    code === 'SOURCE_CHUNK_CONFLICT'
  ) {
    return withProviderCode(
      'OPERATION_CONFLICT',
      'The hosted operation conflicts with current state',
    )
  }
  if (code === 'SOURCE_INTEGRITY_FAILED') {
    return withProviderCode('SYNC_INTEGRITY', 'The hosted source checksum did not match')
  }
  if (code === 'SOURCE_INCOMPLETE') {
    return withProviderCode('SYNC_FAILED', 'The hosted source transfer is incomplete')
  }
  if (code === 'SOURCE_LIMIT_EXCEEDED' || status === 413 || code === 'PAYLOAD_TOO_LARGE') {
    return withProviderCode('SYNC_TOO_LARGE', 'The hosted source transfer exceeds the size limit')
  }
  if (code.includes('PAYMENT')) {
    return withProviderCode(
      'PAYMENT_REQUIRED',
      'The hosted service requires payment for this action',
    )
  }
  if (code.includes('INSUFFICIENT') || code.includes('CREDITS')) {
    return withProviderCode('INSUFFICIENT_CREDITS', 'The hosted account has insufficient credits')
  }
  if (code.includes('QUOTA')) {
    return withProviderCode('PROVIDER_QUOTA', 'The hosted service quota was exceeded')
  }
  if (code.includes('USAGE') || code.includes('LIMIT_EXCEEDED')) {
    return withProviderCode('USAGE_LIMIT', 'The hosted service usage limit was reached')
  }
  if (
    code === 'VALIDATION_ERROR' ||
    code === 'INVALID_REQUEST' ||
    code === 'INVALID_CURSOR' ||
    code === 'IDEMPOTENCY_KEY_REQUIRED' ||
    status === 400 ||
    status === 422
  ) {
    return withProviderCode('INVALID_SPEC', 'The hosted service rejected the request')
  }
  if (status === 405 || status === 406) {
    return withProviderCode('CONFIG_INVALID', 'The hosted service rejected the request method')
  }
  if (status >= 500) {
    return withProviderCode('PROVIDER_UNAVAILABLE', 'The hosted service is temporarily unavailable')
  }
  return withProviderCode('INTERNAL', 'The hosted service returned an unexpected response')
}

export interface ErrorEnvelopeLike {
  readonly error?: { readonly code?: unknown; readonly message?: unknown } | undefined
  readonly requestId?: unknown
}

export function isErrorEnvelopeLike(value: unknown): value is ErrorEnvelopeLike {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  // Index-signature access is required by TS4111; biome's useLiteralKeys
  // suggestion conflicts with the compiler rule here.
  // biome-ignore lint/complexity/useLiteralKeys: Record index signature access
  const error = record['error']
  if (error === null || typeof error !== 'object') return false
  // biome-ignore lint/complexity/useLiteralKeys: Record index signature access
  return typeof (error as Record<string, unknown>)['code'] === 'string'
}

/** Extracts the server code/message/requestId triple from a generated body. */
export function envelopeOf(body: unknown): {
  code?: string | undefined
  message?: string | undefined
  requestId?: string | undefined
} {
  if (!isErrorEnvelopeLike(body)) return {}
  const error = body.error as { code?: unknown; message?: unknown }
  return {
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    ...(typeof error.message === 'string' ? { message: error.message } : {}),
    ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}),
  }
}

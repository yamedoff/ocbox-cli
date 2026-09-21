import { newRequestId } from '../../auth/errors.js'
import { RequestIdSchema, type RequestId } from '../../domain/ids.js'
import { OcboxError, type OcboxErrorCode } from '../../errors/index.js'
import { OcboxErrorCodeSchema } from '../../errors/codes.js'

export interface ApiFailureInput {
  readonly status: number
  readonly serverCode?: string | undefined
  readonly serverMessage?: string | undefined
  readonly requestId?: string | null | undefined
  readonly responseRequestId?: string | null | undefined
  readonly retryAfterSeconds?: number | null | undefined
  readonly operation?: string | undefined
  readonly notFoundCode?: OcboxErrorCode | undefined
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
  return (code ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
}

function catalogueOf(normalized: string): OcboxErrorCode | null {
  if (normalized === '') return null
  const parsed = OcboxErrorCodeSchema.safeParse(normalized)
  return parsed.success ? parsed.data : null
}

const SERVER_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

function validRetryAfter(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isInteger(value) || value < 0) return null
  return value
}

function validServerRequestId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return SERVER_REQUEST_ID_PATTERN.test(value) ? value : null
}

/**
 * Maps hosted HTTP/envelope failures to the stable public catalogue.
 * The pinned contract publishes the same catalogue the CLI owns, so a server
 * code that already names a catalogue entry is preserved exactly; anything
 * else falls back to a status-derived classification. Request IDs are always a
 * valid internal ID while the server request ID survives as redacted
 * `providerRequestId` metadata, and `Retry-After` hints survive as
 * `retryAfterSeconds`, matching the T15 OAuth client convention.
 */
export function mapApiFailureToOcboxError(input: ApiFailureInput): OcboxError {
  const requestId = safeRequestId(input.requestId)
  const code = normalizedCode(input.serverCode)
  const status = input.status
  const preserved = catalogueOf(code)
  const retryAfter = validRetryAfter(input.retryAfterSeconds)
  const serverRequestId =
    validServerRequestId(input.responseRequestId) ??
    validServerRequestId(
      typeof input.requestId === 'string' && RequestIdSchema.safeParse(input.requestId).success
        ? null
        : (input.requestId ?? null),
    )
  const details: Record<string, string | number> = {}
  if (input.operation !== undefined) {
    // biome-ignore lint/complexity/useLiteralKeys: Record index signature access
    details['operation'] = input.operation
  }
  if (retryAfter !== null) {
    // biome-ignore lint/complexity/useLiteralKeys: Record index signature access
    details['retryAfterSeconds'] = retryAfter
  }
  if (
    serverRequestId !== null &&
    serverRequestId !== requestId &&
    validServerRequestId(serverRequestId) !== null
  ) {
    // biome-ignore lint/complexity/useLiteralKeys: Record index signature access
    details['providerRequestId'] = serverRequestId
  }
  const detailsOrUndefined = Object.keys(details).length === 0 ? undefined : details

  const build = (
    errorCode: OcboxErrorCode,
    fallbackMessage: string,
    providerCode: string | undefined = code === '' ? undefined : code.slice(0, 128),
  ): OcboxError => {
    const base = {
      code: errorCode,
      requestId,
      ...(providerCode === undefined ? {} : { providerCode }),
      ...(detailsOrUndefined === undefined ? {} : { details: detailsOrUndefined }),
    }
    const serverMessage = input.serverMessage
    if (typeof serverMessage === 'string' && serverMessage.trim().length > 0) {
      try {
        return new OcboxError({ ...base, message: serverMessage })
      } catch {
        // The server message carried unsafe material; never echo it.
      }
    }
    return new OcboxError({ ...base, message: fallbackMessage })
  }

  if (preserved !== null) {
    return build(preserved, fallbackFor(preserved))
  }
  if (code === 'RATE_LIMITED' || status === 429) {
    return build('PROVIDER_RATE_LIMIT', 'The hosted service rate limit was reached')
  }
  if (code === 'SERVICE_UNAVAILABLE' || status === 503) {
    return build('PROVIDER_UNAVAILABLE', 'The hosted service is temporarily unavailable')
  }
  if (status === 401 || code === 'UNAUTHENTICATED' || code === 'INVALID_CLIENT') {
    return build('AUTH_REQUIRED', 'Authentication is required; run `ocbox auth login`')
  }
  if (code === 'INVALID_GRANT') {
    return build('AUTH_REQUIRED', 'Authentication is required; run `ocbox auth login`')
  }
  if (status === 403 || code === 'FORBIDDEN' || code === 'CSRF_TOKEN_INVALID') {
    return build('AUTH_FORBIDDEN', 'The hosted service refused the authenticated request')
  }
  if (status === 404) {
    const notFound = input.notFoundCode ?? 'PROJECT_NOT_FOUND'
    return build(notFound, 'The requested hosted resource was not found')
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
    return build('OPERATION_CONFLICT', 'The hosted operation conflicts with current state')
  }
  if (code === 'SOURCE_INTEGRITY_FAILED') {
    return build('SYNC_INTEGRITY', 'The hosted source checksum did not match')
  }
  if (code === 'SOURCE_INCOMPLETE') {
    return build('SYNC_FAILED', 'The hosted source transfer is incomplete')
  }
  if (code === 'SOURCE_LIMIT_EXCEEDED' || status === 413 || code === 'PAYLOAD_TOO_LARGE') {
    return build('SYNC_TOO_LARGE', 'The hosted source transfer exceeds the size limit')
  }
  if (code.includes('PAYMENT')) {
    return build('PAYMENT_REQUIRED', 'The hosted service requires payment for this action')
  }
  if (code.includes('INSUFFICIENT') || code.includes('CREDITS')) {
    return build('INSUFFICIENT_CREDITS', 'The hosted account has insufficient credits')
  }
  if (code.includes('QUOTA')) {
    return build('PROVIDER_QUOTA', 'The hosted service quota was exceeded')
  }
  if (code.includes('USAGE') || code.includes('LIMIT_EXCEEDED')) {
    return build('USAGE_LIMIT', 'The hosted service usage limit was reached')
  }
  if (
    code === 'VALIDATION_ERROR' ||
    code === 'INVALID_REQUEST' ||
    code === 'INVALID_CURSOR' ||
    code === 'IDEMPOTENCY_KEY_REQUIRED' ||
    status === 400 ||
    status === 422
  ) {
    return build('INVALID_SPEC', 'The hosted service rejected the request')
  }
  if (status === 405 || status === 406) {
    return build('CONFIG_INVALID', 'The hosted service rejected the request method')
  }
  if (status === 504) {
    return build('PROVIDER_TIMEOUT', 'The hosted service did not respond in time')
  }
  if (status === 500) {
    return build('INTERNAL', 'The hosted service returned an unexpected response')
  }
  if (status >= 500) {
    return build('PROVIDER_UNAVAILABLE', 'The hosted service is temporarily unavailable')
  }
  return build('INTERNAL', 'The hosted service returned an unexpected response')
}

function fallbackFor(code: OcboxErrorCode): string {
  switch (code) {
    case 'AUTH_REQUIRED':
      return 'Authentication is required; run `ocbox auth login`'
    case 'AUTH_EXPIRED':
      return 'The hosted credential is no longer valid; run `ocbox auth login` again'
    case 'AUTH_FORBIDDEN':
      return 'The hosted service refused the request'
    case 'PROVIDER_RATE_LIMIT':
      return 'The hosted service is rate limiting requests; retry later'
    case 'PROVIDER_UNAVAILABLE':
      return 'The hosted service is temporarily unavailable; retry later'
    case 'PROVIDER_TIMEOUT':
      return 'The hosted service did not respond in time'
    case 'PROVIDER_QUOTA':
      return 'The hosted account quota has been exhausted'
    case 'PROVIDER_CAPACITY':
      return 'The hosted service has no capacity for this operation'
    case 'PROVIDER_REGION_UNAVAILABLE':
      return 'The requested hosted region is unavailable'
    case 'OPERATION_CONFLICT':
      return 'The hosted resource is already being mutated; retry the command'
    case 'OPERATION_TIMEOUT':
      return 'The hosted operation did not complete before its deadline'
    case 'OPERATION_CANCELLED':
      return 'The hosted operation was cancelled'
    case 'PROJECT_NOT_FOUND':
      return 'The hosted Project was not found'
    case 'ENVIRONMENT_NOT_FOUND':
      return 'The hosted Session was not found'
    case 'SANDBOX_NOT_FOUND':
      return 'The hosted Sandbox was not found'
    case 'SANDBOX_NOT_READY':
      return 'The hosted Sandbox is not ready'
    case 'PAYMENT_REQUIRED':
      return 'The hosted account requires payment before this operation'
    case 'INSUFFICIENT_CREDITS':
      return 'The hosted account has insufficient credits'
    case 'USAGE_LIMIT':
      return 'The hosted account usage limit has been reached'
    case 'SYNC_TOO_LARGE':
      return 'The hosted service rejected the payload as too large'
    case 'SYNC_INTEGRITY':
      return 'The hosted source checksum did not match'
    case 'SYNC_FAILED':
      return 'The hosted source transfer is incomplete'
    case 'INVALID_SPEC':
      return 'The hosted service rejected the request'
    case 'CAPABILITY_UNSUPPORTED':
      return 'The hosted service does not support this capability'
    default:
      return 'The hosted service returned an unexpected response'
  }
}

export interface ErrorEnvelopeLike {
  readonly error?:
    | {
        readonly code?: unknown
        readonly message?: unknown
        readonly retryAfterSeconds?: unknown
      }
    | undefined
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

/** Extracts the server code/message/requestId/retry hint from a generated body. */
export function envelopeOf(body: unknown): {
  code?: string | undefined
  message?: string | undefined
  requestId?: string | undefined
  retryAfterSeconds?: number | undefined
} {
  if (!isErrorEnvelopeLike(body)) return {}
  const error = body.error as { code?: unknown; message?: unknown; retryAfterSeconds?: unknown }
  const retryAfter =
    typeof error.retryAfterSeconds === 'number' &&
    Number.isInteger(error.retryAfterSeconds) &&
    error.retryAfterSeconds >= 0
      ? error.retryAfterSeconds
      : undefined
  return {
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    ...(typeof error.message === 'string' ? { message: error.message } : {}),
    ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}),
    ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
  }
}

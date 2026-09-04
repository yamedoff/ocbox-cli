import { z } from 'zod'
import { RequestIdSchema, type RequestId } from '../domain/ids.js'
import { OCBOX_ERROR_CODES, OCBOX_ERROR_REGISTRY, type OcboxErrorCode } from './codes.js'

export type SafeJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly SafeJsonValue[]
  | { readonly [key: string]: SafeJsonValue }

const SafeJsonValueSchema: z.ZodType<SafeJsonValue> = z.lazy(() =>
  z.union([
    z.string().max(4_096),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(SafeJsonValueSchema).max(256).readonly(),
    z.record(z.string().min(1).max(128), SafeJsonValueSchema),
  ]),
)

const FORBIDDEN_DETAIL_KEY_FRAGMENTS = [
  'secret',
  'credential',
  'password',
  'token',
  'apikey',
  'commandoutput',
  'output',
  'stdout',
  'stderr',
  'localpath',
  'hostpath',
  'rawprovider',
  'providererror',
  'suffix',
  'preview',
  'recoverable',
  'stack',
  'cause',
] as const
const LOCAL_PATH = /(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\|\/(?:Users|home|root|private\/var)\/)/
const SECRET_CANARY =
  /(?:-----BEGIN [A-Z ]+PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{8,}|\bAKIA[A-Z0-9]{12,}|\bBearer\s+[A-Za-z0-9._~+/-]+=*|(?:password|token|secret|api[_-]?key)\s*[:=]\s*\S+)/i

function inspectSafeValue(
  value: SafeJsonValue,
  report: (path: readonly (string | number)[], message: string) => void,
  path: readonly (string | number)[] = [],
): void {
  if (typeof value === 'string') {
    if (LOCAL_PATH.test(value)) {
      report(path, 'Redacted details cannot contain a local filesystem path')
    }
    if (SECRET_CANARY.test(value)) {
      report(path, 'Redacted details cannot contain credential-like material')
    }
    return
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      inspectSafeValue(item, report, [...path, index])
    }
    return
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = key.replaceAll(/[^A-Za-z0-9]/g, '').toLowerCase()
      if (FORBIDDEN_DETAIL_KEY_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment))) {
        report([...path, key], `Unsafe error-detail key: ${key}`)
      }
      inspectSafeValue(item, report, [...path, key])
    }
  }
}

export const RedactedDetailsSchema = z
  .record(z.string().min(1).max(128), SafeJsonValueSchema)
  .superRefine((details, context) => {
    inspectSafeValue(details, (path, message) => {
      context.addIssue({ code: 'custom', path: [...path], message })
    })
  })

const SafeHumanMessageSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((message) => !LOCAL_PATH.test(message), 'Error message cannot contain a local path')
  .refine(
    (message) => !SECRET_CANARY.test(message),
    'Error message cannot contain credential-like material',
  )

const ProviderCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/)
  .refine(
    (providerCode) => !LOCAL_PATH.test(providerCode) && !SECRET_CANARY.test(providerCode),
    'Provider code must contain only safe non-sensitive metadata',
  )

const OcboxErrorDataVariants = OCBOX_ERROR_CODES.map((code) =>
  z.strictObject({
    code: z.literal(code),
    message: SafeHumanMessageSchema,
    retryable: z.literal(OCBOX_ERROR_REGISTRY[code].retryable),
    requestId: RequestIdSchema,
    providerCode: ProviderCodeSchema.optional(),
    details: RedactedDetailsSchema.optional(),
  }),
)

/**
 * The stable wire shape is a real discriminated union. Each code selects its
 * registry-owned retry literal, so consumers cannot publish a contradictory
 * classification while provider-specific codes remain safe metadata only.
 */
export const OcboxErrorDataSchema = z.discriminatedUnion(
  'code',
  OcboxErrorDataVariants as [
    (typeof OcboxErrorDataVariants)[number],
    ...(typeof OcboxErrorDataVariants)[number][],
  ],
)

export type RedactedDetails = z.infer<typeof RedactedDetailsSchema>
export type OcboxErrorData = z.infer<typeof OcboxErrorDataSchema>

export interface OcboxErrorInput {
  readonly code: OcboxErrorCode
  readonly message: string
  readonly requestId: RequestId
  readonly providerCode?: string
  readonly details?: RedactedDetails
}

/**
 * Stable public error with a deliberately narrow, redaction-checked surface.
 * Raw provider errors, causes, command output, and host paths are not accepted.
 */
export class OcboxError extends Error {
  readonly code: OcboxErrorCode
  readonly retryable: boolean
  readonly requestId: RequestId
  readonly providerCode?: string
  readonly details?: RedactedDetails

  constructor(input: OcboxErrorInput) {
    const parsed = OcboxErrorDataSchema.parse({
      ...input,
      retryable: OCBOX_ERROR_REGISTRY[input.code].retryable,
    })
    super(parsed.message)
    this.name = 'OcboxError'
    this.code = parsed.code
    this.retryable = parsed.retryable
    this.requestId = parsed.requestId
    if (parsed.providerCode !== undefined) this.providerCode = parsed.providerCode
    if (parsed.details !== undefined) this.details = parsed.details
  }

  toJSON(): OcboxErrorData {
    return OcboxErrorDataSchema.parse({
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      requestId: this.requestId,
      ...(this.providerCode === undefined ? {} : { providerCode: this.providerCode }),
      ...(this.details === undefined ? {} : { details: this.details }),
    })
  }
}

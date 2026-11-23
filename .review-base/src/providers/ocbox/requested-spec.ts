import { parse } from 'smol-toml'
import { parseProjectConfig } from '../../config/index.js'
import type { RequestId } from '../../domain/ids.js'
import { OcboxError, type OcboxErrorCode } from '../../errors/index.js'

/** Hosted wire units: CPU cores and memory bytes; image is a reference string. */
export interface HostedRequestedSpec extends Record<string, unknown> {
  cpu?: number
  memory?: number
  image?: string
  region?: string
  runtime?: string
  /** Box size id from the sizes list, and the lifetime asked for it, in seconds. */
  sizeId?: string
  lifetimeSeconds?: number
}

export function requestedSpecFromConfig(source: string): HostedRequestedSpec {
  const config = parseProjectConfig(source)
  const raw = parse(source) as {
    provider?: { region?: unknown; runtimeClass?: unknown }
    sandbox?: { image?: unknown; resources?: { cpuMillicores?: unknown; memoryBytes?: unknown } }
  }
  return {
    ...(raw.sandbox?.resources?.cpuMillicores === undefined
      ? {}
      : { cpu: config.sandbox.resources.cpuMillicores / 1000 }),
    ...(raw.sandbox?.resources?.memoryBytes === undefined
      ? {}
      : { memory: config.sandbox.resources.memoryBytes }),
    ...(raw.sandbox?.image === undefined ? {} : { image: config.sandbox.image.reference }),
    ...(raw.provider?.region === undefined ? {} : { region: config.provider.region }),
    ...(raw.provider?.runtimeClass === undefined ? {} : { runtime: config.provider.runtimeClass }),
  }
}

/** The resource flags a customer passed on the command line, as hosted request fields. */
export function requestedSpecFromFlags(flags: {
  readonly cpu?: number | undefined
  readonly memory?: number | undefined
  readonly image?: string | undefined
  readonly region?: string | undefined
  readonly runtime?: string | undefined
  readonly size?: string | undefined
  readonly lifetime?: number | undefined
}): HostedRequestedSpec {
  return {
    ...(flags.cpu === undefined ? {} : { cpu: flags.cpu }),
    ...(flags.memory === undefined ? {} : { memory: flags.memory }),
    ...(flags.image === undefined ? {} : { image: flags.image }),
    ...(flags.region === undefined ? {} : { region: flags.region }),
    ...(flags.runtime === undefined ? {} : { runtime: flags.runtime }),
    ...(flags.size === undefined ? {} : { sizeId: flags.size }),
    ...(flags.lifetime === undefined ? {} : { lifetimeSeconds: flags.lifetime }),
  }
}

export const ADMISSION_MESSAGES: Readonly<Record<string, string>> = {
  spec_not_allowed:
    'The requested resources exceed your plan; remove resource overrides to use the free default.',
  admission_closed: 'New hosted sessions are temporarily unavailable; try again later.',
  user_active_limit:
    'You have reached your active session limit; stop an existing session and retry.',
  global_capacity: 'Hosted capacity is currently full; try again later.',
  budget_exhausted:
    'Your hosted usage budget is exhausted; check your account budget before retrying.',
}

const ADMISSION_CODES: Readonly<Record<string, OcboxErrorCode>> = {
  spec_not_allowed: 'INVALID_SPEC',
  admission_closed: 'PROVIDER_UNAVAILABLE',
  user_active_limit: 'USAGE_LIMIT',
  global_capacity: 'PROVIDER_CAPACITY',
  budget_exhausted: 'INSUFFICIENT_CREDITS',
}

export function admissionError(
  code: string | undefined,
  requestId: RequestId,
): OcboxError | undefined {
  const denial = code?.toLowerCase()
  if (!denial || !Object.hasOwn(ADMISSION_MESSAGES, denial)) return undefined
  const message = ADMISSION_MESSAGES[denial]
  if (message === undefined) return undefined
  return new OcboxError({
    code: ADMISSION_CODES[denial] ?? 'INVALID_SPEC',
    message,
    providerCode: denial,
    requestId,
  })
}

/** Refusals the hosted API names with a reason code when a size or lifetime is outside the plan. */
export const SIZE_REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  size_not_in_plan:
    'This box size is not available on your plan; run `ocbox sizes` to see the sizes you can use.',
  lifetime_over_limit:
    'The requested lifetime is longer than this size allows; run `ocbox sizes` to see the maximum lifetime of each size, then retry with a shorter --lifetime.',
}

export function sizeRefusalError(
  reasonCode: string | undefined,
  requestId: RequestId,
): OcboxError | undefined {
  if (reasonCode === undefined || !Object.hasOwn(SIZE_REFUSAL_MESSAGES, reasonCode))
    return undefined
  const message = SIZE_REFUSAL_MESSAGES[reasonCode]
  if (message === undefined) return undefined
  return new OcboxError({ code: 'INVALID_SPEC', message, providerCode: reasonCode, requestId })
}

export function friendlyAdmissionFailure(error: unknown): never {
  if (error instanceof OcboxError)
    throw admissionError(error.providerCode, error.requestId) ?? error
  throw error
}

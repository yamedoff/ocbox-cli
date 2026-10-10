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

export function friendlyAdmissionFailure(error: unknown): never {
  if (error instanceof OcboxError)
    throw admissionError(error.providerCode, error.requestId) ?? error
  throw error
}

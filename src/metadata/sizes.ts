import { z } from 'zod'
import type { OcboxApiClient } from '../api/client/index.js'
import { newRequestId } from '../auth/errors.js'
import { RequestIdSchema } from '../domain/ids.js'
import { OcboxError } from '../errors/index.js'

/**
 * One box size the plan offers. Tolerant on purpose: only `id` is required and
 * unknown fields are dropped, so an older or newer service never breaks the
 * list and nothing the CLI does not know about reaches its output.
 */
export const BoxSizeSchema = z.object({
  id: z.string().min(1),
  gpuType: z.string().nullable().optional(),
  gpuCount: z.number().optional(),
  cpuMillicores: z.number().optional(),
  memoryBytes: z.number().optional(),
  diskBytes: z.number().optional(),
  maxLifetimeSeconds: z.number().optional(),
  price: z.object({ microUsdPerHour: z.number() }).optional(),
})
export const BoxSizePageSchema = z.object({ data: z.array(BoxSizeSchema) })
export type BoxSize = z.infer<typeof BoxSizeSchema>

/** Reads the sizes the caller's plan allows, in the order the plan lists them. */
export async function listSizes(
  api: OcboxApiClient,
  signal?: AbortSignal,
): Promise<{ readonly sizes: readonly BoxSize[] }> {
  const response = await api.listSizes(signal)
  const { body, meta } = api.assertSuccess('sizes.list', response, [200])
  const parsed = BoxSizePageSchema.safeParse(body)
  if (!parsed.success) {
    throw new OcboxError({
      code: 'INTERNAL',
      message: 'Hosted sizes response does not match the public contract',
      requestId: RequestIdSchema.safeParse(meta.requestId).data ?? newRequestId(),
    })
  }
  return { sizes: parsed.data.data }
}

function amount(bytes: number): string {
  const gib = bytes / 1024 ** 3
  return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`
}

function duration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

/** One line per size: id, what it has, the longest life, the hourly price. */
export function sizeLine(size: BoxSize): string {
  const parts: string[] = []
  if (size.gpuCount !== undefined)
    parts.push(
      size.gpuCount === 0 || size.gpuType == null
        ? 'no GPU'
        : `${size.gpuCount} x ${size.gpuType}`,
    )
  if (size.cpuMillicores !== undefined) parts.push(`${size.cpuMillicores / 1000} CPU`)
  if (size.memoryBytes !== undefined) parts.push(`${amount(size.memoryBytes)} memory`)
  if (size.diskBytes !== undefined) parts.push(`${amount(size.diskBytes)} disk`)
  if (size.maxLifetimeSeconds !== undefined) parts.push(`max ${duration(size.maxLifetimeSeconds)}`)
  if (size.price !== undefined)
    parts.push(`$${(size.price.microUsdPerHour / 1_000_000).toFixed(2)}/h`)
  return parts.length === 0 ? size.id : `${size.id}  ${parts.join(', ')}`
}

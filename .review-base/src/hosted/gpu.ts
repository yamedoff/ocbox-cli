import { z } from 'zod'
import type { GpuCheckQuery, OcboxApiClient } from '../api/client/index.js'
import { parseHostedResponse } from './response.js'

const gpuReason = z.enum([
  'size_not_in_plan',
  'lifetime_over_limit',
  'gpu_budget_exhausted',
  'gpu_unavailable',
  'spec_not_allowed',
])
const problemField = z.enum([
  'gpu.type',
  'gpu.count',
  'gpu',
  'lifetimeSeconds',
  'gpuHours',
  'cpu',
  'memory',
  'disk',
])
const alternative = z.strictObject({
  sizeId: z.string().min(1),
  gpu: z.strictObject({ type: z.string().min(1), count: z.number().int().positive() }),
  maxLifetimeSeconds: z.number().int().nonnegative(),
  price: z.strictObject({ microUsdPerHour: z.number() }),
  capacityKnown: z.boolean(),
})
const problem = z.strictObject({
  field: problemField,
  reason: gpuReason,
  message: z.string().min(1),
  requested: z.string(),
  availableNow: z.array(z.string()),
})
export const GpuCheckResultSchema = z.discriminatedUnion('ok', [
  alternative.extend({
    ok: z.literal(true),
    lifetimeSeconds: z.number().int().positive(),
    message: z.string().min(1),
  }),
  z.strictObject({
    ok: z.literal(false),
    reason: gpuReason,
    message: z.string().min(1),
    problems: z.array(problem),
    alternatives: z.array(alternative),
  }),
])
export type GpuCheckResult = z.infer<typeof GpuCheckResultSchema>
type GpuCheckAlternative = z.infer<typeof alternative>

/** The read-only answer to "can I have this GPU box now?"; reserves nothing. */
export async function checkGpu(
  api: OcboxApiClient,
  query: GpuCheckQuery,
  signal?: AbortSignal,
): Promise<{ readonly gpuCheck: GpuCheckResult }> {
  const response = await api.checkGpuSpec(query, signal)
  const { resource } = parseHostedResponse(
    api,
    'gpu.check',
    response,
    [200],
    GpuCheckResultSchema,
    'GPU check',
  )
  return { gpuCheck: resource }
}

function alternativeLine(entry: GpuCheckAlternative): string {
  return `${entry.sizeId} (${entry.gpu.count} x ${entry.gpu.type}, max ${entry.maxLifetimeSeconds}s, ${entry.price.microUsdPerHour} microUSD/hour)`
}

/** Human answer: every problem and its reason, then the plan's alternatives. */
export function renderGpuCheck(result: { readonly gpuCheck: GpuCheckResult }): string {
  const check = result.gpuCheck
  if (check.ok) {
    return `OK: ${alternativeLine(check)}, lifetime ${check.lifetimeSeconds}s`
  }
  const lines = [`Not possible: ${check.message}`]
  for (const entry of check.problems) {
    const available =
      entry.availableNow.length === 0 ? '' : `; available now: ${entry.availableNow.join(', ')}`
    lines.push(
      `- ${entry.field}: ${entry.message} (reason ${entry.reason}; requested ${entry.requested}${available})`,
    )
  }
  if (check.alternatives.length > 0) {
    lines.push(`Alternatives: ${check.alternatives.map(alternativeLine).join('; ')}`)
  }
  return lines.join('\n')
}

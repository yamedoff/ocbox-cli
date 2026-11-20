import { z } from 'zod'
import type { OcboxApiClient } from '../api/client/index.js'
import { parseHostedResponse } from './response.js'

const microcredits = z.string().regex(/^(0|[1-9][0-9]*)$/)
const signedMicrocredits = z.string().regex(/^-?(0|[1-9][0-9]*)$/)
export const BillingWalletSchema = z.strictObject({
  ownerId: z.string().min(1),
  availableMicrocredits: microcredits,
  reservedMicrocredits: microcredits,
  consumedMicrocredits: microcredits,
  expiredMicrocredits: microcredits,
  grantedMicrocredits: microcredits,
  adjustmentsMicrocredits: signedMicrocredits,
})
export const BillingUsageSchema = z.strictObject({
  eventId: z.string().min(1),
  ownerId: z.string().min(1),
  billingMode: z.enum(['managed', 'byok']),
  billable: z.boolean(),
  quantity: microcredits,
  unit: z.string().min(1),
  source: z.string().min(1),
  windowStart: z.iso.datetime({ offset: true }),
  windowEnd: z.iso.datetime({ offset: true }),
  ingestedAt: z.iso.datetime({ offset: true }),
  providerReportId: z.string().min(1).nullable().optional(),
  sessionId: z.string().min(1).nullable().optional(),
})
export const BillingUsagePageSchema = z.strictObject({
  data: z.array(BillingUsageSchema),
  nextCursor: z.string().nullable(),
})
export type BillingWallet = z.infer<typeof BillingWalletSchema>
export type BillingUsage = z.infer<typeof BillingUsageSchema>

export interface ListUsageInput {
  readonly sessionId?: string | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

/** One page of owner-scoped usage events; an optional sessionId filters the page. */
export async function listUsage(
  api: OcboxApiClient,
  input: ListUsageInput,
  signal?: AbortSignal,
): Promise<{ readonly usage: readonly BillingUsage[]; readonly nextCursor: string | null }> {
  const response = await api.generated.listBillingUsage({
    query: {
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    },
    ...(signal === undefined ? {} : { signal }),
  })
  const { resource } = parseHostedResponse(
    api,
    'usage.list',
    response,
    [200],
    BillingUsagePageSchema,
    'usage',
  )
  const usage =
    input.sessionId === undefined
      ? resource.data
      : resource.data.filter((event) => event.sessionId === input.sessionId)
  return { usage, nextCursor: resource.nextCursor }
}

/** The derived wallet projection; balances are computed, never stored. */
export async function getWallet(
  api: OcboxApiClient,
  signal?: AbortSignal,
): Promise<{ readonly wallet: BillingWallet }> {
  const response = await api.generated.getBillingWallet(
    signal === undefined ? undefined : { signal },
  )
  const { resource } = parseHostedResponse(
    api,
    'wallet.get',
    response,
    [200],
    BillingWalletSchema,
    'wallet',
  )
  return { wallet: resource }
}

/** One line per usage event, in the order the API returned it. */
export function usageLine(event: BillingUsage): string {
  const session = event.sessionId == null ? '' : ` session=${event.sessionId}`
  return `${event.eventId}  ${event.windowStart}..${event.windowEnd}  ${event.quantity} ${event.unit}  ${event.source}  billable=${String(event.billable)}${session}`
}

/** Human wallet: every derived balance in microcredits. */
export function walletLine(wallet: BillingWallet): string {
  return [
    `Available ${wallet.availableMicrocredits} microcredits`,
    `reserved ${wallet.reservedMicrocredits}`,
    `consumed ${wallet.consumedMicrocredits}`,
    `granted ${wallet.grantedMicrocredits}`,
    `expired ${wallet.expiredMicrocredits}`,
    `adjustments ${wallet.adjustmentsMicrocredits}`,
  ].join('; ')
}

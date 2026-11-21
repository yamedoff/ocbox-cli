import { z } from 'zod'
import { HostedSessionSchema } from '../providers/ocbox/wire.js'

export const WARM_PROTOCOL_VERSION = 1 as const

export const WarmRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({
    hostedSessionId: z.string().min(1),
    op: z.literal('get'),
    v: z.literal(WARM_PROTOCOL_VERSION),
  }),
  z.strictObject({
    hostedSessionId: z.string().min(1),
    op: z.literal('remember'),
    session: HostedSessionSchema,
    v: z.literal(WARM_PROTOCOL_VERSION),
  }),
  z.strictObject({
    op: z.literal('ping'),
    v: z.literal(WARM_PROTOCOL_VERSION),
  }),
])

export type WarmRequest = z.infer<typeof WarmRequestSchema>

const WarmErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
})

export const WarmResponseSchema = z.union([
  z.strictObject({
    cached: z.boolean().optional(),
    ok: z.literal(true),
    session: HostedSessionSchema.optional(),
    v: z.literal(WARM_PROTOCOL_VERSION),
  }),
  z.strictObject({
    error: WarmErrorSchema,
    ok: z.literal(false),
    v: z.literal(WARM_PROTOCOL_VERSION),
  }),
])

export type WarmResponse = z.infer<typeof WarmResponseSchema>

/** Encodes one protocol frame; the socket carries newline-delimited JSON. */
export function encodeWarmMessage(message: WarmRequest | WarmResponse): string {
  return `${JSON.stringify(message)}\n`
}

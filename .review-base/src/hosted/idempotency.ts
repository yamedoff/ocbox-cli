import { randomUUID } from 'node:crypto'
import { newRequestId } from '../auth/errors.js'
import { IdempotencyKeySchema } from '../domain/ids.js'
import { OcboxError } from '../errors/index.js'

/** A caller-supplied key or a fresh UUID, validated before it reaches the wire. */
export function idempotencyKey(value: string | undefined): string {
  const parsed = IdempotencyKeySchema.safeParse(value ?? randomUUID())
  if (!parsed.success) {
    throw new OcboxError({
      code: 'CONFIG_INVALID',
      message: 'Invalid idempotency key; use 16–128 transport-safe characters',
      requestId: newRequestId(),
    })
  }
  return parsed.data
}

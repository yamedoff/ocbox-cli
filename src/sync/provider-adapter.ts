import { randomUUID } from 'node:crypto'
import { RequestIdSchema } from '../domain/ids.js'
import { OcboxError } from '../errors/index.js'
import { LocalTransferAdapter } from './local-transfer-adapter.js'
import type { TransferAdapter } from './transfer.js'

/** Local transfer is reserved for the offline fake provider. */
export function createTransferAdapter(providerName: string, targetRoot: string): TransferAdapter {
  if (providerName === 'fake') return new LocalTransferAdapter(targetRoot)
  throw new OcboxError({
    code: 'CAPABILITY_UNSUPPORTED',
    message: `Provider ${providerName} does not implement a sync transfer adapter yet`,
    requestId: RequestIdSchema.parse(randomUUID()),
    details: { provider: providerName },
  })
}

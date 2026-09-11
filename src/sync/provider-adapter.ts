import { randomUUID } from 'node:crypto'
import { RequestIdSchema } from '../domain/ids.js'
import { OcboxError } from '../errors/index.js'
import { LocalTransferAdapter } from './local-transfer-adapter.js'
import type { TransferAdapter } from './transfer.js'

/**
 * Provider seam for the sync transport. The v0.1 fake provider (and the
 * repository's local/fake test target) uses the journaled local adapter. T8 can
 * register real adapters here without changing the CLI or planner contracts.
 */
export function createTransferAdapter(providerName: string, targetRoot: string): TransferAdapter {
  if (providerName === 'fake') return new LocalTransferAdapter(targetRoot)
  throw new OcboxError({
    code: 'CAPABILITY_UNSUPPORTED',
    message: `Provider ${providerName} does not implement a sync transfer adapter yet`,
    requestId: RequestIdSchema.parse(randomUUID()),
    details: { provider: providerName },
  })
}

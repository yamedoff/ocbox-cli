import { randomUUID } from 'node:crypto'
import { RequestIdSchema } from '../domain/ids.js'
import { OcboxError } from '../errors/index.js'
import { LocalTransferAdapter } from './local-transfer-adapter.js'
import type { TransferAdapter } from './transfer.js'

/**
 * Provider seam for the sync transport. Local staging is provider-independent
 * and keeps the T6 secret/path guarantees for every provider; the hosted
 * `ocbox` provider uploads the staged, scanned manifest through the
 * manifest/chunk/checksum protocol (`uploadPreparedSource`) instead of a
 * secret-file bypass. T8 can register real adapters here without changing the
 * CLI or planner contracts.
 */
export function createTransferAdapter(providerName: string, targetRoot: string): TransferAdapter {
  if (providerName === 'fake' || providerName === 'ocbox')
    return new LocalTransferAdapter(targetRoot)
  throw new OcboxError({
    code: 'CAPABILITY_UNSUPPORTED',
    message: `Provider ${providerName} does not implement a sync transfer adapter yet`,
    requestId: RequestIdSchema.parse(randomUUID()),
    details: { provider: providerName },
  })
}

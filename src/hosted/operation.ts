import type { z } from 'zod'
import type { OcboxApiClient } from '../api/client/index.js'
import { HostedOperationSchema } from '../metadata/client.js'
import { parseHostedResponse } from './response.js'
import { safeErrorReason } from './safe-error.js'

export type OperationRecord = z.infer<typeof HostedOperationSchema>

function options(signal: AbortSignal | undefined) {
  return signal === undefined ? {} : { signal }
}

/** Read one durable operation; pending/running is in progress, the rest terminal. */
export async function getOperation(
  api: OcboxApiClient,
  operationId: string,
  signal?: AbortSignal,
): Promise<{ readonly operation: OperationRecord }> {
  const response = await api.generated.getOperation({
    path: { operationId },
    ...options(signal),
  })
  const { resource } = parseHostedResponse(
    api,
    'operation.get',
    response,
    [200],
    HostedOperationSchema,
    'operation',
  )
  return { operation: resource }
}

/** Request cancellation of a cancellable operation; the answer is durable. */
export async function cancelOperation(
  api: OcboxApiClient,
  operationId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<{ readonly operation: OperationRecord }> {
  const response = await api.generated.cancelOperation({
    path: { operationId },
    idempotencyKey,
    ...options(signal),
  })
  const { resource } = parseHostedResponse(
    api,
    'operation.cancel',
    response,
    [202],
    HostedOperationSchema,
    'operation',
  )
  return { operation: resource }
}

/** One line per operation: state, kind, progress and the stored failure reason. */
export function operationLine(operation: OperationRecord): string {
  const line = `Operation ${operation.id}: ${operation.state} (${operation.kind}, ${operation.progress}%)`
  const reason = safeErrorReason(operation.error)
  return reason === undefined ? line : `${line}\nReason ${reason}.`
}

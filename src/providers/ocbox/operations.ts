import type {
  OpenCloudBoxClient,
  Operation as HostedOperation,
} from '../../api/generated/client.js'
import { OcboxError } from '../../errors/index.js'
import { newRequestId } from '../../auth/errors.js'
import { mapApiFailureToOcboxError, toRequestId } from '../../api/client/errors.js'
import type { OcboxApiClient } from '../../api/client/client.js'

export interface WaitOperationOptions {
  readonly deadlineMilliseconds?: number | undefined
  readonly pollMilliseconds?: number | undefined
  readonly signal?: AbortSignal | undefined
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined
  readonly now?: (() => number) | undefined
}

const DEFAULT_DEADLINE_MS = 5 * 60_000
const DEFAULT_POLL_MS = 1_000
const MAX_POLL_MS = 10_000

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })

function cancelledError(): OcboxError {
  return new OcboxError({
    code: 'OPERATION_CANCELLED',
    message: 'The hosted operation wait was cancelled',
    requestId: newRequestId(),
  })
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelledError()
}

/**
 * Durable operation waiter. Polling is stateless by operation ID, so a CLI
 * restart can resume with the same ID. It obeys server retry hints, applies
 * bounded exponential backoff, enforces a deadline, and maps terminal
 * failures losslessly with request IDs preserved.
 */
export async function waitForHostedOperation(
  api: OcboxApiClient,
  operationId: string,
  options: WaitOperationOptions = {},
): Promise<{ operation: HostedOperation; requestId: string | null; replay: boolean }> {
  const deadlineMs = options.deadlineMilliseconds ?? DEFAULT_DEADLINE_MS
  const basePollMs = options.pollMilliseconds ?? DEFAULT_POLL_MS
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const startedAt = now()
  let attempt = 0
  for (;;) {
    throwIfCancelled(options.signal)
    const result = await api.generated.getOperation({
      path: { operationId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (result.status === 429 || result.status === 503) {
      const raw = result.body as { error?: { retryAfterSeconds?: unknown } }
      const retryHint =
        typeof raw === 'object' &&
        raw !== null &&
        typeof raw.error === 'object' &&
        raw.error !== null
          ? (raw.error as { retryAfterSeconds?: unknown }).retryAfterSeconds
          : undefined
      const retryAfter = typeof retryHint === 'number' ? retryHint : 1
      const delayMs = Math.min(MAX_POLL_MS, Math.max(0, retryAfter * 1_000))
      if (now() - startedAt + delayMs > deadlineMs) {
        throw new OcboxError({
          code: 'OPERATION_TIMEOUT',
          message: 'The hosted operation did not complete in time',
          requestId: toRequestId(result.requestId),
        })
      }
      await sleep(delayMs)
      attempt += 1
      continue
    }
    const { body, meta } = api.assertSuccess('getOperation', result, [200])
    const operation = body as HostedOperation
    if (operation.state === 'succeeded') {
      return { operation, replay: meta.replay, requestId: meta.requestId }
    }
    if (operation.state === 'cancelled') {
      throw new OcboxError({
        code: 'OPERATION_CANCELLED',
        message: 'The hosted operation was cancelled',
        requestId: toRequestId(operation.requestId),
        ...(operation.error === null ? {} : { providerCode: operation.error.code.slice(0, 128) }),
      })
    }
    if (operation.state === 'failed') {
      const serverCode = operation.error?.code
      throw mapApiFailureToOcboxError({
        operation: `operation:${operation.kind}`,
        requestId: operation.requestId,
        serverCode: serverCode ?? undefined,
        status: 422,
      })
    }
    const hinted = operation.error?.retryAfterSeconds ?? null
    const backoffMs = Math.min(MAX_POLL_MS, basePollMs * 2 ** Math.min(attempt, 4))
    const delayMs = hinted !== null ? Math.min(MAX_POLL_MS, Math.max(0, hinted * 1_000)) : backoffMs
    if (now() - startedAt + delayMs > deadlineMs) {
      throw new OcboxError({
        code: 'OPERATION_TIMEOUT',
        message: 'The hosted operation did not complete in time',
        requestId: toRequestId(operation.requestId),
      })
    }
    await sleep(delayMs)
    attempt += 1
  }
}

/** Requests cancellation; the waiter observes the terminal `cancelled` state. */
export async function cancelHostedOperation(
  api: OcboxApiClient,
  operationId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<HostedOperation> {
  const result = await api.generated.cancelOperation({
    path: { operationId },
    idempotencyKey,
    ...(signal === undefined ? {} : { signal }),
  })
  const { body } = api.assertSuccess('cancelOperation', result, [200, 202])
  return body as HostedOperation
}

export function hostedClientOf(api: OcboxApiClient): OpenCloudBoxClient {
  return api.generated
}

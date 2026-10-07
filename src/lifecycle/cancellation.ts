import { setTimeout as delay } from 'node:timers/promises'
import type { RequestId, SandboxId } from '../contracts.js'
import { OcboxError } from '../errors/index.js'

export interface CancellationResult {
  readonly executionId: string
  readonly sandboxId: SandboxId
  readonly state: 'completed' | 'cancelled' | 'failed'
}

export function executionError(
  requestId: RequestId,
  message: string,
  code: 'INVALID_STATE' | 'SANDBOX_NOT_FOUND' = 'INVALID_STATE',
): OcboxError {
  return new OcboxError({ code, message, requestId })
}

/** The deadline also bounds in-flight HTTP reads, not just polling sleeps. */
export async function waitForCancellation<T>(
  requestId: RequestId,
  milliseconds: number,
  signal: AbortSignal | undefined,
  action: (signal: AbortSignal, pause: () => Promise<void>) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 2_147_483_647) {
    throw executionError(
      requestId,
      'Cancellation wait must be a positive number of milliseconds at most 2147483647',
    )
  }
  const deadline = AbortSignal.timeout(milliseconds)
  const combined = signal === undefined ? deadline : AbortSignal.any([deadline, signal])
  try {
    return await action(combined, async () => {
      await delay(100, undefined, { signal: combined })
    })
  } catch (error) {
    if (combined.aborted) {
      throw new OcboxError({
        code: signal?.aborted ? 'OPERATION_CANCELLED' : 'OPERATION_TIMEOUT',
        message: signal?.aborted
          ? 'Cancellation wait interrupted'
          : 'Execution did not reach a terminal state before the cancellation wait deadline',
        requestId,
      })
    }
    throw error
  }
}

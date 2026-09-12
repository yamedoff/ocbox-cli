import type {
  OpenCloudBoxClient,
  Operation as HostedOperation,
} from '../../api/generated/client.js'
import { OcboxError } from '../../errors/index.js'
import { newRequestId } from '../../auth/errors.js'
import { RequestIdSchema } from '../../domain/ids.js'
import { IdempotencyKeySchema } from '../../domain/ids.js'
import { envelopeOf, mapApiFailureToOcboxError, toRequestId } from '../../api/client/errors.js'
import type { OcboxApiClient } from '../../api/client/client.js'
import {
  DEFAULT_RETRY_POLICY,
  Deadline,
  type RetryPolicy,
  resolvePollDelayMilliseconds,
  sleepWithSignal,
} from './retry.js'
import {
  HostedOperationSchema,
  isTerminalOperationState,
  type HostedOperationState,
} from './wire.js'

export interface WaitOperationOptions {
  readonly deadlineMilliseconds?: number | undefined
  readonly maxWaitMilliseconds?: number | undefined
  readonly pollMilliseconds?: number | undefined
  readonly signal?: AbortSignal | undefined
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined
  readonly now?: (() => number) | undefined
  readonly store?: OperationCheckpointStore | undefined
  readonly policy?: RetryPolicy | undefined
  readonly random?: (() => number) | undefined
  readonly createId?: (() => string) | undefined
}

/**
 * Durable checkpoint written after every poll. A restarted CLI can reload the
 * last observed Operation state (and retry attempt) and either return a
 * terminal result without any network call or resume polling where it stopped.
 */
export interface OperationCheckpoint {
  readonly operationId: string
  readonly state: HostedOperationState | null
  readonly progress: number
  readonly requestId: string | null
  readonly attempt: number
  readonly operation: HostedOperation | null
}

export interface OperationCheckpointStore {
  load(operationId: string): Promise<OperationCheckpoint | null>
  save(checkpoint: OperationCheckpoint): Promise<void>
}

/** Deterministic in-memory store used by tests and ephemeral CLI invocations. */
export class MemoryOperationCheckpointStore implements OperationCheckpointStore {
  readonly #entries = new Map<string, OperationCheckpoint>()

  load(operationId: string): Promise<OperationCheckpoint | null> {
    return Promise.resolve(this.#entries.get(operationId) ?? null)
  }

  save(checkpoint: OperationCheckpoint): Promise<void> {
    this.#entries.set(checkpoint.operationId, checkpoint)
    return Promise.resolve()
  }
}

const DEFAULT_DEADLINE_MS = 5 * 60_000

function freshRequestId(createId: (() => string) | undefined): ReturnType<typeof newRequestId> {
  if (createId === undefined) return newRequestId()
  const parsed = RequestIdSchema.safeParse(createId())
  return parsed.success ? parsed.data : newRequestId()
}

function cancelledError(createId: (() => string) | undefined): OcboxError {
  return new OcboxError({
    code: 'OPERATION_CANCELLED',
    message: 'The hosted operation wait was cancelled',
    requestId: freshRequestId(createId),
  })
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false
}

function throwIfCancelled(
  signal: AbortSignal | undefined,
  createId: (() => string) | undefined,
): void {
  if (isAborted(signal)) throw cancelledError(createId)
}

const defaultSleep = (milliseconds: number): Promise<void> => sleepWithSignal(milliseconds)

async function abortableSleep(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal | undefined,
  createId: (() => string) | undefined,
): Promise<void> {
  if (isAborted(signal)) throw cancelledError(createId)
  try {
    if (sleep === defaultSleep) {
      await sleepWithSignal(milliseconds, signal)
    } else {
      await sleep(milliseconds)
    }
  } catch (error) {
    if (isAborted(signal)) throw cancelledError(createId)
    if (error instanceof Error && error.name === 'AbortError') throw cancelledError(createId)
    throw error
  }
  if (isAborted(signal)) throw cancelledError(createId)
}

function retryAfterOf(body: unknown): number | null {
  if (body === null || typeof body !== 'object') return null
  const error = (body as { error?: unknown }).error
  if (error === null || typeof error !== 'object') return null
  const value = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * Durable operation waiter. Polling is stateless by operation ID, so a CLI
 * restart can resume with the same ID, and a checkpoint store lets a restart
 * return a terminal result without any network call. It obeys server retry
 * hints, applies bounded exponential backoff with jitter, enforces a
 * wall-clock deadline, validates the wire shape and operation identity, and
 * maps terminal failures losslessly with request IDs preserved.
 */
export async function waitForHostedOperation(
  api: OcboxApiClient,
  operationId: string,
  options: WaitOperationOptions = {},
): Promise<{
  operation: HostedOperation
  requestId: string | null
  replay: boolean
  fromCheckpoint: boolean
}> {
  const deadlineMs =
    options.deadlineMilliseconds ?? options.maxWaitMilliseconds ?? DEFAULT_DEADLINE_MS
  const policy: RetryPolicy =
    options.policy ??
    (options.pollMilliseconds === undefined
      ? DEFAULT_RETRY_POLICY
      : {
          baseMilliseconds: options.pollMilliseconds,
          jitterRatio: 0.2,
          maxMilliseconds: 10_000,
          multiplier: 2,
        })
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const createId = options.createId
  const checkpoint = (await options.store?.load(operationId)) ?? null
  if (
    checkpoint !== null &&
    checkpoint.operation !== null &&
    checkpoint.state !== null &&
    isTerminalOperationState(checkpoint.state)
  ) {
    return {
      fromCheckpoint: true,
      operation: checkpoint.operation,
      replay: false,
      requestId: checkpoint.requestId,
    }
  }
  const deadline = new Deadline(deadlineMs, now)
  let attempt = checkpoint?.attempt ?? 0
  const save = async (
    state: HostedOperationState | null,
    progress: number,
    requestId: string | null,
    operation: HostedOperation | null,
  ): Promise<void> => {
    await options.store?.save({ attempt, operation, operationId, progress, requestId, state })
  }

  for (;;) {
    throwIfCancelled(options.signal, createId)
    if (deadline.exceeded()) {
      throw new OcboxError({
        code: 'OPERATION_TIMEOUT',
        message: 'The hosted operation did not complete in time',
        requestId: freshRequestId(createId),
        details: { operationId },
      })
    }
    attempt += 1
    let result: Awaited<ReturnType<OcboxApiClient['generated']['getOperation']>>
    try {
      result = await api.generated.getOperation({
        path: { operationId },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      if (options.signal?.aborted === true) throw cancelledError(createId)
      throw error
    }
    if (result.status < 200 || result.status >= 300) {
      const envelope = envelopeOf(result.body)
      const mapped = mapApiFailureToOcboxError({
        operation: 'getOperation',
        requestId: result.requestId ?? envelope.requestId ?? null,
        responseRequestId: envelope.requestId ?? result.requestId ?? null,
        retryAfterSeconds: envelope.retryAfterSeconds ?? retryAfterOf(result.body),
        serverCode: envelope.code,
        serverMessage: envelope.message,
        status: result.status,
      })
      if (mapped.retryable) {
        await save(
          checkpoint?.state ?? null,
          checkpoint?.progress ?? 0,
          result.requestId,
          checkpoint?.operation ?? null,
        )
        const delay = Math.min(
          resolvePollDelayMilliseconds({
            attempt,
            policy,
            random,
            retryAfterSeconds: retryAfterOf(result.body),
          }),
          deadline.remainingMilliseconds(),
        )
        if (deadline.remainingMilliseconds() <= 0) {
          throw new OcboxError({
            code: 'OPERATION_TIMEOUT',
            message: 'The hosted operation did not complete in time',
            requestId: toRequestId(result.requestId),
            details: { operationId },
          })
        }
        await abortableSleep(sleep, delay, options.signal, createId)
        continue
      }
      throw mapped
    }
    const parsed = HostedOperationSchema.safeParse(result.body)
    if (!parsed.success || parsed.data.id !== operationId) {
      throw new OcboxError({
        code: 'INTERNAL',
        message: 'The hosted service returned an unexpected Operation representation',
        requestId: freshRequestId(createId),
      })
    }
    const operation = parsed.data as unknown as HostedOperation
    throwIfCancelled(options.signal, createId)
    await save(operation.state, operation.progress, result.requestId, operation)
    if (operation.state === 'succeeded') {
      return {
        fromCheckpoint: false,
        operation,
        replay: result.replay,
        requestId: result.requestId,
      }
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
      throw mapApiFailureToOcboxError({
        operation: `operation:${operation.kind}`,
        requestId: operation.requestId,
        responseRequestId: operation.requestId,
        retryAfterSeconds: operation.error?.retryAfterSeconds ?? null,
        serverCode: operation.error?.code ?? undefined,
        serverMessage: operation.error?.message ?? undefined,
        status: 422,
      })
    }
    const remaining = deadline.remainingMilliseconds()
    if (remaining <= 0) {
      throw new OcboxError({
        code: 'OPERATION_TIMEOUT',
        message: 'The hosted operation did not complete in time',
        requestId: toRequestId(operation.requestId),
        details: { operationId },
      })
    }
    const delay = Math.min(
      resolvePollDelayMilliseconds({
        attempt,
        policy,
        random,
        retryAfterSeconds: operation.error?.retryAfterSeconds ?? null,
      }),
      remaining,
    )
    await abortableSleep(sleep, delay, options.signal, createId)
  }
}

/**
 * Requests cancellation. The caller-provided idempotency key is validated once
 * and reused verbatim on every retryable failure, so a retried cancel replays
 * instead of applying twice. The waiter observes the terminal `cancelled`
 * state.
 */
export async function cancelHostedOperation(
  api: OcboxApiClient,
  operationId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<HostedOperation> {
  const key = IdempotencyKeySchema.parse(idempotencyKey)
  const deadline = new Deadline(DEFAULT_DEADLINE_MS)
  let attempt = 0
  for (;;) {
    if (signal?.aborted === true) throw cancelledError(undefined)
    if (deadline.exceeded()) {
      throw new OcboxError({
        code: 'OPERATION_TIMEOUT',
        message: 'The hosted operation cancel did not complete in time',
        requestId: newRequestId(),
        details: { operationId },
      })
    }
    attempt += 1
    const result = await api.generated.cancelOperation({
      path: { operationId },
      idempotencyKey: key,
      ...(signal === undefined ? {} : { signal }),
    })
    if (result.status < 200 || result.status >= 300) {
      const envelope = envelopeOf(result.body)
      const mapped = mapApiFailureToOcboxError({
        operation: 'cancelOperation',
        requestId: result.requestId ?? envelope.requestId ?? null,
        responseRequestId: envelope.requestId ?? result.requestId ?? null,
        retryAfterSeconds: envelope.retryAfterSeconds ?? retryAfterOf(result.body),
        serverCode: envelope.code,
        serverMessage: envelope.message,
        status: result.status,
      })
      if (!mapped.retryable) throw mapped
      const remaining = deadline.remainingMilliseconds()
      if (remaining <= 0) {
        throw new OcboxError({
          code: 'OPERATION_TIMEOUT',
          message: 'The hosted operation cancel did not complete in time',
          requestId: toRequestId(result.requestId),
          details: { operationId },
        })
      }
      await sleepWithSignal(
        Math.min(
          resolvePollDelayMilliseconds({ attempt, retryAfterSeconds: retryAfterOf(result.body) }),
          remaining,
        ),
        signal,
      ).catch((error) => {
        if (signal?.aborted === true) throw cancelledError(undefined)
        if (error instanceof Error && error.name === 'AbortError') throw cancelledError(undefined)
        throw error
      })
      continue
    }
    const parsed = HostedOperationSchema.safeParse(result.body)
    if (!parsed.success || parsed.data.id !== operationId) {
      throw new OcboxError({
        code: 'INTERNAL',
        message: 'The hosted service returned an unexpected Operation representation',
        requestId: newRequestId(),
      })
    }
    return parsed.data as unknown as HostedOperation
  }
}

export function hostedClientOf(api: OcboxApiClient): OpenCloudBoxClient {
  return api.generated
}

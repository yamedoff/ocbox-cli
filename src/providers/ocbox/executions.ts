import type {
  ExecutionEvent as HostedEvent,
  ExecutionResult as HostedResult,
} from '../../api/generated/client.js'
import type { OcboxApiClient } from '../../api/client/client.js'
import { envelopeOf, mapApiFailureToOcboxError, toRequestId } from '../../api/client/errors.js'
import type { ExecEvent, ExecResult, Execution } from '../../domain/execution.js'
import { ExecutionIdSchema, type ExecutionId } from '../../domain/ids.js'
import { UtcTimestampSchema } from '../../domain/timestamps.js'
import { OcboxError } from '../../errors/index.js'
import { newRequestId } from '../../auth/errors.js'
import {
  DEFAULT_RETRY_POLICY,
  Deadline,
  type RetryPolicy,
  resolvePollDelayMilliseconds,
  sleepWithSignal,
} from './retry.js'
import {
  HostedExecutionEventPageSchema,
  HostedExecutionResultSchema,
  HostedExecutionSchema,
  isTerminalExecutionState,
  type HostedExecutionEvent,
} from './wire.js'

export interface CollectedExecution {
  readonly executionId: string
  readonly events: readonly HostedEvent[]
  readonly result: HostedResult
}

export interface HostedExecutionCheckpoint {
  readonly executionId: string
  readonly cursor: string | null
  readonly lastSequence: number
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new OcboxError({
      code: 'OPERATION_CANCELLED',
      message: 'The hosted execution wait was cancelled',
      requestId: newRequestId(),
    })
  }
}

const defaultSleep = (milliseconds: number): Promise<void> => sleepWithSignal(milliseconds)

export interface PollExecutionOptions {
  readonly deadlineMilliseconds?: number | undefined
  readonly maxWaitMilliseconds?: number | undefined
  readonly pollMilliseconds?: number | undefined
  readonly pollIntervalMilliseconds?: number | undefined
  readonly signal?: AbortSignal | undefined
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined
  readonly now?: (() => number) | undefined
  readonly policy?: RetryPolicy | undefined
  readonly random?: (() => number) | undefined
  readonly eventPageLimit?: number | undefined
  readonly maxStreamFailures?: number | undefined
  readonly checkpoint?: HostedExecutionCheckpoint | undefined
  readonly onCheckpoint?: ((checkpoint: HostedExecutionCheckpoint) => void) | undefined
  readonly onProgress?: ((event: HostedExecutionEvent) => void) | undefined
}

function retryAfterOf(body: unknown): number | null {
  if (body === null || typeof body !== 'object') return null
  const error = (body as { error?: unknown }).error
  if (error === null || typeof error !== 'object') return null
  const value = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function retryAfterOfError(error: unknown): number | null {
  if (!(error instanceof OcboxError)) return null
  // biome-ignore lint/complexity/useLiteralKeys: Record index signature access
  const value = error.details?.['retryAfterSeconds']
  return typeof value === 'number' ? value : null
}

/**
 * Polls execution events with cursor resume. Duplicate server sequences are
 * dropped so a resumed cursor never replays output; progress events are
 * reported through `onProgress` instead of the output stream. A dropped event
 * stream falls back to polling execution state and result after bounded
 * failures. Cancellation is explicit and never conflated with a nonzero
 * command exit.
 */
export async function collectExecutionEvents(
  api: OcboxApiClient,
  executionId: string,
  options: PollExecutionOptions = {},
): Promise<CollectedExecution> {
  const deadlineMs = options.deadlineMilliseconds ?? options.maxWaitMilliseconds ?? 5 * 60_000
  const pollMs = options.pollMilliseconds ?? options.pollIntervalMilliseconds ?? 250
  const eventLimit = options.eventPageLimit ?? 100
  const maxFailures = options.maxStreamFailures ?? 3
  const policy = options.policy ?? DEFAULT_RETRY_POLICY
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const deadline = new Deadline(deadlineMs, now)
  let cursor: string | null = options.checkpoint?.cursor ?? null
  let lastSequence = options.checkpoint?.lastSequence ?? -1
  const seen: HostedEvent[] = []
  let failures = 0
  let attempt = 0

  const pause = async (milliseconds: number): Promise<void> => {
    try {
      if (sleep === defaultSleep) {
        await sleepWithSignal(milliseconds, options.signal)
      } else {
        await sleep(milliseconds)
      }
    } catch (error) {
      if (options.signal?.aborted === true) throwIfCancelled(options.signal)
      if (error instanceof Error && error.name === 'AbortError') throwIfCancelled(options.signal)
      throw error
    }
    throwIfCancelled(options.signal)
  }

  const readExecution = async (): Promise<{ state: string; requestId: string | null }> => {
    for (;;) {
      throwIfCancelled(options.signal)
      if (deadline.exceeded()) {
        throw new OcboxError({
          code: 'OPERATION_TIMEOUT',
          message: 'The hosted execution did not complete in time',
          requestId: newRequestId(),
        })
      }
      attempt += 1
      const execution = await api.generated.getExecution({
        path: { executionId },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      if (execution.status >= 200 && execution.status < 300) {
        const parsed = HostedExecutionSchema.safeParse(execution.body)
        if (!parsed.success) {
          throw new OcboxError({
            code: 'INTERNAL',
            message: 'The hosted service returned an unexpected Execution representation',
            requestId: newRequestId(),
          })
        }
        return { requestId: execution.requestId, state: parsed.data.state }
      }
      const envelope = envelopeOf(execution.body)
      const mapped = mapApiFailureToOcboxError({
        notFoundCode: 'SANDBOX_NOT_FOUND',
        operation: 'getExecution',
        requestId: execution.requestId ?? envelope.requestId ?? null,
        responseRequestId: envelope.requestId ?? execution.requestId ?? null,
        retryAfterSeconds: envelope.retryAfterSeconds ?? retryAfterOf(execution.body),
        serverCode: envelope.code,
        serverMessage: envelope.message,
        status: execution.status,
      })
      if (!mapped.retryable) throw mapped
      const remaining = deadline.remainingMilliseconds()
      if (remaining <= 0) {
        throw new OcboxError({
          code: 'OPERATION_TIMEOUT',
          message: 'The hosted execution did not complete in time',
          requestId: toRequestId(execution.requestId),
        })
      }
      await pause(
        Math.min(
          resolvePollDelayMilliseconds({
            attempt,
            policy,
            random,
            retryAfterSeconds: retryAfterOf(execution.body),
          }),
          remaining,
        ),
      )
    }
  }

  const readResult = async (): Promise<HostedResult> => {
    for (;;) {
      throwIfCancelled(options.signal)
      if (deadline.exceeded()) {
        throw new OcboxError({
          code: 'OPERATION_TIMEOUT',
          message: 'The hosted execution did not complete in time',
          requestId: newRequestId(),
        })
      }
      attempt += 1
      const finalResult = await api.generated.getExecutionResult({
        path: { executionId },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      if (finalResult.status >= 200 && finalResult.status < 300) {
        const parsed = HostedExecutionResultSchema.safeParse(finalResult.body)
        if (!parsed.success) {
          throw new OcboxError({
            code: 'INTERNAL',
            message: 'The hosted service returned an unexpected Execution result representation',
            requestId: newRequestId(),
          })
        }
        return parsed.data as unknown as HostedResult
      }
      const envelope = envelopeOf(finalResult.body)
      const mapped = mapApiFailureToOcboxError({
        notFoundCode: 'SANDBOX_NOT_FOUND',
        operation: 'getExecutionResult',
        requestId: finalResult.requestId ?? envelope.requestId ?? null,
        responseRequestId: envelope.requestId ?? finalResult.requestId ?? null,
        retryAfterSeconds: envelope.retryAfterSeconds ?? retryAfterOf(finalResult.body),
        serverCode: envelope.code,
        serverMessage: envelope.message,
        status: finalResult.status,
      })
      if (!mapped.retryable) throw mapped
      const remaining = deadline.remainingMilliseconds()
      if (remaining <= 0) {
        throw new OcboxError({
          code: 'OPERATION_TIMEOUT',
          message: 'The hosted execution did not complete in time',
          requestId: toRequestId(finalResult.requestId),
        })
      }
      await pause(
        Math.min(
          resolvePollDelayMilliseconds({
            attempt,
            policy,
            random,
            retryAfterSeconds: retryAfterOf(finalResult.body),
          }),
          remaining,
        ),
      )
    }
  }

  const pollFallback = async (): Promise<CollectedExecution> => {
    for (;;) {
      throwIfCancelled(options.signal)
      if (deadline.exceeded()) {
        throw new OcboxError({
          code: 'OPERATION_TIMEOUT',
          message: 'The hosted execution did not complete in time',
          requestId: newRequestId(),
        })
      }
      const current = await readExecution()
      if (
        current.state === 'completed' ||
        current.state === 'cancelled' ||
        current.state === 'failed'
      ) {
        return { events: seen, executionId, result: await readResult() }
      }
      await pause(pollMs)
    }
  }

  for (;;) {
    throwIfCancelled(options.signal)
    if (deadline.exceeded()) {
      throw new OcboxError({
        code: 'OPERATION_TIMEOUT',
        message: 'The hosted execution did not complete in time',
        requestId: newRequestId(),
      })
    }
    let page: { data: readonly HostedExecutionEvent[]; nextCursor: string | null }
    try {
      const result = await api.generated.listExecutionEvents({
        path: { executionId },
        query: { limit: eventLimit, ...(cursor === null ? {} : { cursor }) },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      if (result.status < 200 || result.status >= 300) {
        const envelope = envelopeOf(result.body)
        throw mapApiFailureToOcboxError({
          notFoundCode: 'SANDBOX_NOT_FOUND',
          operation: 'listExecutionEvents',
          requestId: result.requestId ?? envelope.requestId ?? null,
          responseRequestId: envelope.requestId ?? result.requestId ?? null,
          retryAfterSeconds: envelope.retryAfterSeconds ?? retryAfterOf(result.body),
          serverCode: envelope.code,
          serverMessage: envelope.message,
          status: result.status,
        })
      }
      const parsed = HostedExecutionEventPageSchema.safeParse(result.body)
      if (!parsed.success) {
        throw new OcboxError({
          code: 'INTERNAL',
          message: 'The hosted service returned an unexpected Execution event page representation',
          requestId: newRequestId(),
        })
      }
      page = parsed.data
    } catch (error) {
      if (options.signal?.aborted === true) throwIfCancelled(options.signal)
      if (error instanceof OcboxError && !error.retryable) throw error
      failures += 1
      attempt += 1
      if (failures > maxFailures) {
        return await pollFallback()
      }
      await pause(
        resolvePollDelayMilliseconds({
          attempt,
          policy,
          random,
          retryAfterSeconds: retryAfterOfError(error),
        }),
      )
      continue
    }
    failures = 0
    let sawTerminal = false
    const ordered = [...page.data].sort((a, b) => a.sequence - b.sequence)
    for (const event of ordered) {
      if (event.sequence <= lastSequence) continue
      lastSequence = event.sequence
      if (event.kind === 'progress') {
        options.onProgress?.(event)
        continue
      }
      if (event.kind === 'started') {
        seen.push(event as unknown as HostedEvent)
        continue
      }
      if (event.kind === 'stdout' || event.kind === 'stderr') {
        seen.push(event as unknown as HostedEvent)
        continue
      }
      seen.push(event as unknown as HostedEvent)
      sawTerminal = true
    }
    cursor = page.nextCursor
    options.onCheckpoint?.({ cursor, executionId, lastSequence })
    if (sawTerminal) {
      return { events: seen, executionId, result: await readResult() }
    }
    if (page.nextCursor === null) {
      const current = await readExecution()
      if (
        isTerminalExecutionState(
          current.state as 'completed' | 'cancelled' | 'failed' | 'pending' | 'running',
        )
      ) {
        return { events: seen, executionId, result: await readResult() }
      }
      if (deadline.exceeded()) {
        throw new OcboxError({
          code: 'OPERATION_TIMEOUT',
          message: 'The hosted execution did not complete in time',
          requestId: toRequestId(current.requestId),
        })
      }
      await pause(pollMs)
    }
  }
}

/**
 * Maps the hosted result to `ExecResult` without treating nonzero exits as
 * transport errors. The event stream is authoritative for output, so the
 * terminal result carries empty buffers to prevent duplicate or unbounded
 * output in a second payload, matching the local execution contract.
 */
export function toExecResult(
  result: HostedResult,
  timing: { startedAt: string; completedAt: string },
): ExecResult {
  const startedAt = UtcTimestampSchema.parse(timing.startedAt)
  const rawCompleted = UtcTimestampSchema.parse(timing.completedAt)
  const completedAt = rawCompleted < startedAt ? startedAt : rawCompleted
  if (result.kind === 'cancelled') {
    throw new OcboxError({
      code: 'OPERATION_CANCELLED',
      message: 'The hosted execution was cancelled',
      requestId: newRequestId(),
    })
  }
  if (result.kind === 'infrastructure') {
    throw new OcboxError({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'The hosted execution infrastructure failed',
      providerCode: result.error.code.slice(0, 128),
      requestId: newRequestId(),
    })
  }
  if (!Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255) {
    throw new OcboxError({
      code: 'INTERNAL',
      message: 'The hosted service returned an out-of-range execution exit code',
      requestId: newRequestId(),
    })
  }
  return {
    cancelled: false,
    completedAt,
    exitCode: result.exitCode,
    signal: null,
    startedAt,
    stderr: new Uint8Array(),
    stdout: new Uint8Array(),
    timedOut: false,
  }
}

/**
 * Converts hosted events to domain `ExecEvent`s in dense sequence order.
 * Server sequences may skip (for example progress events); the CLI output
 * capture contract requires dense strictly increasing sequences starting at
 * zero with monotonic timestamps, so events are renumbered here.
 */
export function toExecEvents(
  executionId: ExecutionId,
  events: readonly HostedEvent[],
  timing: { startedAt: string },
): ExecEvent[] {
  const id = ExecutionIdSchema.parse(executionId)
  const startedAt = UtcTimestampSchema.parse(timing.startedAt)
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence)
  const out: ExecEvent[] = []
  let sequence = 0
  let lastTimestamp: string = ''
  let sawStarted = false
  for (const event of ordered) {
    const raw = UtcTimestampSchema.parse(event.at)
    const timestamp = (raw < lastTimestamp ? lastTimestamp : raw) as typeof raw
    lastTimestamp = timestamp
    if (event.kind === 'started') {
      sawStarted = true
      out.push({ executionId: id, sequence, timestamp, type: 'started' })
      sequence += 1
    } else if (event.kind === 'stdout') {
      out.push({
        data: new TextEncoder().encode(event.message),
        executionId: id,
        sequence,
        timestamp,
        type: 'stdout',
      })
      sequence += 1
    } else if (event.kind === 'stderr') {
      out.push({
        data: new TextEncoder().encode(event.message),
        executionId: id,
        sequence,
        timestamp,
        type: 'stderr',
      })
      sequence += 1
    }
  }
  if (!sawStarted) {
    const synthesized: ExecEvent[] = [
      { executionId: id, sequence: 0, timestamp: startedAt, type: 'started' },
    ]
    for (const event of out) {
      const shiftedTimestamp = (
        event.timestamp < startedAt ? startedAt : event.timestamp
      ) as typeof startedAt
      synthesized.push({
        ...event,
        sequence: event.sequence + 1,
        timestamp: shiftedTimestamp,
      } as ExecEvent)
    }
    return synthesized
  }
  return out
}

export type { Execution }

import type {
  ExecutionEvent as HostedEvent,
  ExecutionResult as HostedResult,
} from '../../api/generated/client.js'
import type { OcboxApiClient } from '../../api/client/client.js'
import { toRequestId } from '../../api/client/errors.js'
import type { ExecEvent, ExecResult, Execution } from '../../domain/execution.js'
import { ExecutionIdSchema, type ExecutionId } from '../../domain/ids.js'
import { UtcTimestampSchema } from '../../domain/timestamps.js'
import { OcboxError } from '../../errors/index.js'
import { newRequestId } from '../../auth/errors.js'

export interface CollectedExecution {
  readonly executionId: string
  readonly events: readonly HostedEvent[]
  readonly result: HostedResult
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

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })

export interface PollExecutionOptions {
  readonly deadlineMilliseconds?: number | undefined
  readonly pollMilliseconds?: number | undefined
  readonly signal?: AbortSignal | undefined
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined
  readonly now?: (() => number) | undefined
}

/**
 * Polls execution events with cursor resume. Dropped streams resume from the
 * last observed sequence; cancellation is explicit and never conflated with a
 * nonzero command exit.
 */
export async function collectExecutionEvents(
  api: OcboxApiClient,
  executionId: string,
  options: PollExecutionOptions = {},
): Promise<CollectedExecution> {
  const deadlineMs = options.deadlineMilliseconds ?? 5 * 60_000
  const pollMs = options.pollMilliseconds ?? 500
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const startedAt = now()
  let cursor: string | undefined
  let lastSequence = -1
  const seen: HostedEvent[] = []
  for (;;) {
    throwIfCancelled(options.signal)
    const result = await api.generated.listExecutionEvents({
      path: { executionId },
      ...(cursor === undefined ? {} : { query: { cursor } }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const { body } = api.assertSuccess('listExecutionEvents', result, [200])
    const page = body as { data: readonly HostedEvent[]; nextCursor: string | null }
    for (const event of page.data) {
      if (event.sequence <= lastSequence) continue
      lastSequence = event.sequence
      seen.push(event)
    }
    const terminal = seen.find(
      (event) =>
        event.kind === 'completed' || event.kind === 'failed' || event.kind === 'cancelled',
    )
    if (terminal !== undefined) {
      const finalResult = await api.generated.getExecutionResult({
        path: { executionId },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      const verified = api.assertSuccess('getExecutionResult', finalResult, [200])
      return { events: seen, executionId, result: verified.body as HostedResult }
    }
    const execution = await api.generated.getExecution({
      path: { executionId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const current = api.assertSuccess('getExecution', execution, [200])
    const state = (current.body as { state: string }).state
    if (state === 'completed' || state === 'cancelled' || state === 'failed') {
      const finalResult = await api.generated.getExecutionResult({
        path: { executionId },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      const verified = api.assertSuccess('getExecutionResult', finalResult, [200])
      return { events: seen, executionId, result: verified.body as HostedResult }
    }
    if (page.nextCursor !== null) {
      cursor = page.nextCursor
      continue
    }
    if (now() - startedAt > deadlineMs) {
      throw new OcboxError({
        code: 'OPERATION_TIMEOUT',
        message: 'The hosted execution did not complete in time',
        requestId: toRequestId(current.meta.requestId),
      })
    }
    await sleep(pollMs)
  }
}

/** Maps the hosted result to `ExecResult` without treating nonzero exits as transport errors. */
export function toExecResult(
  result: HostedResult,
  timing: { startedAt: string; completedAt: string },
): ExecResult {
  const startedAt = UtcTimestampSchema.parse(timing.startedAt)
  const completedAt = UtcTimestampSchema.parse(timing.completedAt)
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
  return {
    cancelled: false,
    completedAt,
    exitCode: result.exitCode,
    signal: null,
    startedAt,
    stderr: new TextEncoder().encode(result.stderr),
    stdout: new TextEncoder().encode(result.stdout),
    timedOut: false,
  }
}

/** Converts hosted events to domain `ExecEvent`s in sequence order. */
export function toExecEvents(
  executionId: ExecutionId,
  events: readonly HostedEvent[],
  timing: { startedAt: string },
): ExecEvent[] {
  const id = ExecutionIdSchema.parse(executionId)
  const out: ExecEvent[] = []
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const timestamp = UtcTimestampSchema.parse(event.at)
    if (event.kind === 'started') {
      out.push({ executionId: id, sequence: event.sequence, timestamp, type: 'started' })
    } else if (event.kind === 'stdout') {
      out.push({
        data: new TextEncoder().encode(event.message),
        executionId: id,
        sequence: event.sequence,
        timestamp,
        type: 'stdout',
      })
    } else if (event.kind === 'stderr') {
      out.push({
        data: new TextEncoder().encode(event.message),
        executionId: id,
        sequence: event.sequence,
        timestamp,
        type: 'stderr',
      })
    }
  }
  void timing
  return out
}

export type { Execution }

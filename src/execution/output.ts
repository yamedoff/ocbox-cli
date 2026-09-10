import { once } from 'node:events'
import type { ExecEvent } from '../contracts.js'
import type { ExecutionOutputMode } from './cli-arguments.js'
import type { ExecutionOutcome } from './exit-policy.js'
import type { ExecutionCompletion } from './service.js'

export interface ExecutionWritable {
  write(chunk: string | Uint8Array): unknown
  once?(event: 'drain', listener: () => void): unknown
}

async function write(stream: ExecutionWritable, data: string | Uint8Array): Promise<void> {
  const accepted = stream.write(data)
  if (accepted !== false) return
  if (stream.once === undefined)
    throw new TypeError('Backpressured stream must support drain events')
  await once(stream as NodeJS.WritableStream, 'drain')
}

function eventEnvelope(event: ExecEvent): object {
  if (event.type === 'stdout' || event.type === 'stderr') {
    return {
      schemaVersion: 1,
      kind: 'event',
      outcome: null,
      event: event.type,
      executionId: event.executionId,
      sequence: event.sequence,
      timestamp: event.timestamp,
      encoding: 'base64',
      data: Buffer.from(event.data).toString('base64'),
    }
  }
  if (event.type === 'completed') {
    const outcome = event.result.timedOut
      ? 'timeout'
      : event.result.cancelled
        ? 'cancelled'
        : 'remote_result'
    return {
      schemaVersion: 1,
      kind: 'event',
      outcome,
      event: event.type,
      executionId: event.executionId,
      sequence: event.sequence,
      timestamp: event.timestamp,
      result: {
        exitCode: event.result.exitCode,
        signal: event.result.signal,
        startedAt: event.result.startedAt,
        completedAt: event.result.completedAt,
      },
    }
  }
  return { schemaVersion: 1, kind: 'event', outcome: null, event: event.type, ...event }
}

/** Writes command output directly; it is never sent through logs or the general redactor. */
export function createExecutionEventSink(
  mode: ExecutionOutputMode,
  stdout: ExecutionWritable,
  stderr: ExecutionWritable,
): (event: ExecEvent) => Promise<void> {
  if (mode === 'human') {
    return async (event) => {
      if (event.type === 'stdout') await write(stdout, event.data)
      if (event.type === 'stderr') await write(stderr, event.data)
    }
  }
  if (mode === 'json') return async () => {}
  return (event) => write(stdout, `${JSON.stringify(eventEnvelope(event))}\n`)
}

/** Shared result envelope; typed pre-start detail keeps structured output actionable. */
function resultEnvelope(outcome: ExecutionOutcome): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'result',
    outcome: outcome.kind,
    ...(outcome.kind === 'infrastructure_error' && outcome.detail !== undefined
      ? { error: outcome.detail }
      : {}),
  }
}

/** Emits the bounded final envelope for JSON, or a safe terminal diagnostic for human mode. */
export async function writeExecutionCompletion(
  mode: ExecutionOutputMode,
  completion: ExecutionCompletion,
  stdout: ExecutionWritable,
  stderr: ExecutionWritable,
): Promise<void> {
  if (mode === 'jsonl') {
    if (completion.outcome.kind === 'infrastructure_error' || completion.output === null) {
      await write(stdout, `${JSON.stringify(resultEnvelope(completion.outcome))}\n`)
    }
    return
  }
  if (mode === 'human') {
    if (completion.outcome.kind === 'timeout') await write(stderr, 'Execution timed out\n')
    if (completion.outcome.kind === 'cancelled') await write(stderr, 'Execution cancelled\n')
    if (completion.outcome.kind === 'infrastructure_error') {
      await write(
        stderr,
        `${completion.outcome.detail?.message ?? 'Execution infrastructure failed'}\n`,
      )
    }
    return
  }
  const envelope =
    completion.output === null
      ? resultEnvelope(completion.outcome)
      : {
          schemaVersion: 1,
          kind: 'result',
          outcome: completion.outcome.kind,
          result: {
            exitCode: completion.output.result.exitCode,
            signal: completion.output.result.signal,
            startedAt: completion.output.result.startedAt,
            completedAt: completion.output.result.completedAt,
          },
          stdout: completion.output.stdout,
          stderr: completion.output.stderr,
        }
  await write(stdout, `${JSON.stringify(envelope)}\n`)
}

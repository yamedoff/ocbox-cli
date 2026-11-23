import { ExecEventSchema, type ExecEvent, type ExecResult } from '../domain/execution.js'
import type { ExecutionId } from '../domain/ids.js'

export interface CapturedStream {
  readonly encoding: 'base64'
  readonly data: string
  readonly retainedBytes: number
  readonly totalBytes: number
  readonly truncated: boolean
}

/** Binary-safe bounded output for a final JSON envelope; never persist this value. */
export interface CapturedExecutionOutput {
  readonly stdout: CapturedStream
  readonly stderr: CapturedStream
  readonly result: ExecResult
}

export class ExecutionStreamError extends Error {
  constructor() {
    super('Execution stream ended without a valid ordered terminal result')
    this.name = 'ExecutionStreamError'
  }
}

class PrefixCapture {
  readonly #buffer: Buffer
  #retained = 0
  #total = 0

  constructor(limit: number) {
    this.#buffer = Buffer.alloc(limit)
  }

  append(data: Uint8Array): void {
    if (!Number.isSafeInteger(this.#total + data.byteLength)) throw new ExecutionStreamError()
    this.#total += data.byteLength
    const count = Math.min(data.byteLength, this.#buffer.byteLength - this.#retained)
    this.#buffer.set(data.subarray(0, count), this.#retained)
    this.#retained += count
  }

  finish(): CapturedStream {
    return {
      encoding: 'base64',
      data: this.#buffer.subarray(0, this.#retained).toString('base64'),
      retainedBytes: this.#retained,
      totalBytes: this.#total,
      truncated: this.#retained < this.#total,
    }
  }
}

/**
 * Pulls one event at a time and awaits the sink before requesting the next.
 * Human sinks write raw bytes; JSONL sinks encode data as base64. Awaiting their
 * write completion is the backpressure boundary. This function never logs output.
 * Final-result stdout/stderr must be empty: the event stream is authoritative,
 * preventing duplicate or unbounded output in a second terminal payload.
 */
export async function consumeExecutionOutput(
  executionId: ExecutionId,
  events: AsyncIterable<ExecEvent>,
  sink: (event: ExecEvent) => Promise<void>,
  retainedBytesPerStream = 65_536,
): Promise<CapturedExecutionOutput> {
  if (
    !Number.isSafeInteger(retainedBytesPerStream) ||
    retainedBytesPerStream < 0 ||
    retainedBytesPerStream > 1_048_576
  ) {
    throw new RangeError('Output capture limit must be between 0 and 1048576 bytes')
  }
  const stdout = new PrefixCapture(retainedBytesPerStream)
  const stderr = new PrefixCapture(retainedBytesPerStream)
  let sequence = 0
  let lastTimestamp = ''
  let result: ExecResult | undefined
  for await (const candidate of events) {
    const parsed = ExecEventSchema.safeParse(candidate)
    if (!parsed.success) throw new ExecutionStreamError()
    const event = parsed.data
    if (
      event.executionId !== executionId ||
      event.sequence !== sequence ||
      event.timestamp < lastTimestamp ||
      result !== undefined
    ) {
      throw new ExecutionStreamError()
    }
    if ((sequence === 0) !== (event.type === 'started')) throw new ExecutionStreamError()
    if (event.type === 'stdout') stdout.append(event.data)
    if (event.type === 'stderr') stderr.append(event.data)
    if (event.type === 'completed') {
      if (event.result.stdout.byteLength !== 0 || event.result.stderr.byteLength !== 0)
        throw new ExecutionStreamError()
      result = event.result
    }
    await sink(event)
    sequence++
    lastTimestamp = event.timestamp
  }
  if (result === undefined) throw new ExecutionStreamError()
  return { stdout: stdout.finish(), stderr: stderr.finish(), result }
}

import { describe, expect, it } from 'vitest'
import type { ExecEvent, ExecResult } from '../../src/domain/execution.js'
import { ExecutionIdSchema } from '../../src/domain/ids.js'
import { UtcTimestampSchema } from '../../src/domain/timestamps.js'
import { consumeExecutionOutput, ExecutionStreamError } from '../../src/execution/stream-output.js'

const id = ExecutionIdSchema.parse('12345678-1234-4234-8234-123456789abc')
const timestamp = UtcTimestampSchema.parse('2026-09-08T12:00:00.000Z')
const result: ExecResult = {
  exitCode: 17,
  stdout: new Uint8Array(),
  stderr: new Uint8Array(),
  timedOut: false,
  cancelled: false,
  signal: null,
  startedAt: timestamp,
  completedAt: timestamp,
}
function event(sequence: number, data?: Uint8Array): ExecEvent {
  const base = { executionId: id, sequence, timestamp }
  if (sequence === 0) return { ...base, type: 'started' }
  return data === undefined
    ? { ...base, type: 'completed', result }
    : { ...base, type: 'stdout', data: Uint8Array.from(data) }
}
async function* events(...values: ExecEvent[]): AsyncIterable<ExecEvent> {
  yield* values
}

describe('bounded execution output', () => {
  it('preserves split Unicode as bytes and reports exact prefix truncation', async () => {
    const bytes = Buffer.from('🙂日本語')
    const output = await consumeExecutionOutput(
      id,
      events(event(0), event(1, bytes.subarray(0, 1)), event(2, bytes.subarray(1)), event(3)),
      async () => {},
      5,
    )
    expect(Buffer.from(output.stdout.data, 'base64')).toEqual(bytes.subarray(0, 5))
    expect(output.stdout).toMatchObject({
      retainedBytes: 5,
      totalBytes: bytes.length,
      truncated: true,
    })
    expect(output.result.exitCode).toBe(17)
  })

  it('awaits sink completion before requesting another event', async () => {
    let requested = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    async function* source() {
      requested++
      yield event(0)
      requested++
      yield event(1)
    }
    const running = consumeExecutionOutput(id, source(), async (value) => {
      if (value.type === 'started') await gate
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(requested).toBe(1)
    release()
    await running
    expect(requested).toBe(2)
  })

  it('captures a fixed prefix while draining a large output flood', async () => {
    const chunk = Buffer.alloc(65_536, 120)
    async function* flood() {
      yield event(0)
      for (let i = 1; i <= 128; i++) yield event(i, chunk)
      yield event(129)
    }
    const output = await consumeExecutionOutput(id, flood(), async () => {}, 128)
    expect(output.stdout).toMatchObject({
      retainedBytes: 128,
      totalBytes: 8_388_608,
      truncated: true,
    })
    expect(output.stdout.data.length).toBe(172)
  })

  it.each([
    [event(0)],
    [event(0), event(2)],
    [event(0), event(1), event(2, Buffer.from('late'))],
    [event(0), event(1, Buffer.from('data'))],
  ])('rejects disconnected, reordered or post-terminal streams', async (...input) => {
    await expect(
      consumeExecutionOutput(id, events(...input), async () => {}),
    ).rejects.toBeInstanceOf(ExecutionStreamError)
  })
})

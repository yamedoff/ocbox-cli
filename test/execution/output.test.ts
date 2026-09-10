import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { ExecEvent, ExecResult } from '../../src/contracts.js'
import {
  createExecutionEventSink,
  writeExecutionCompletion,
  type ExecutionWritable,
} from '../../src/execution/output.js'
import { ExecutionInfrastructureError } from '../../src/execution/exit-policy.js'
import type { ExecutionCompletion } from '../../src/execution/service.js'
import { ids, timestamps } from '../contracts/test-data.js'

class MemoryWritable implements ExecutionWritable {
  readonly chunks: Buffer[] = []

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(Buffer.from(chunk))
    return true
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

const result: ExecResult = {
  exitCode: 125,
  stdout: new Uint8Array(),
  stderr: new Uint8Array(),
  timedOut: false,
  cancelled: false,
  signal: null,
  startedAt: timestamps.created,
  completedAt: timestamps.completed,
}

function dataEvent(type: 'stdout' | 'stderr', data: Uint8Array): ExecEvent {
  return {
    type,
    executionId: ids.execution,
    sequence: type === 'stdout' ? 1 : 2,
    timestamp: timestamps.observed,
    data: new Uint8Array(data),
  }
}

describe('execution-specific output', () => {
  it('writes human stdout and stderr as exact raw bytes', async () => {
    const stdout = new MemoryWritable()
    const stderr = new MemoryWritable()
    const sink = createExecutionEventSink('human', stdout, stderr)
    await sink(dataEvent('stdout', Uint8Array.of(0, 255, 1)))
    await sink(dataEvent('stderr', Buffer.from('日本語')))
    expect(Buffer.concat(stdout.chunks)).toEqual(Buffer.from([0, 255, 1]))
    expect(Buffer.concat(stderr.chunks)).toEqual(Buffer.from('日本語'))
  })

  it('waits for a backpressured writable to drain', async () => {
    class BackpressuredWritable extends EventEmitter implements ExecutionWritable {
      write(): boolean {
        return false
      }
    }
    const stream = new BackpressuredWritable()
    let settled = false
    const writing = createExecutionEventSink(
      'human',
      stream,
      new MemoryWritable(),
    )(dataEvent('stdout', Buffer.from('data'))).then(() => {
      settled = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    stream.emit('drain')
    await writing
    expect(settled).toBe(true)
  })

  it('base64 encodes JSONL data and disambiguates a remote exit 125', async () => {
    const stdout = new MemoryWritable()
    const sink = createExecutionEventSink('jsonl', stdout, new MemoryWritable())
    await sink(dataEvent('stdout', Uint8Array.of(0, 255)))
    await sink({
      type: 'completed',
      executionId: ids.execution,
      sequence: 2,
      timestamp: timestamps.completed,
      result,
    })
    const lines = stdout
      .text()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines[0]).toMatchObject({ event: 'stdout', encoding: 'base64', data: 'AP8=' })
    expect(lines[1]).toMatchObject({ outcome: 'remote_result', result: { exitCode: 125 } })
  })

  it('emits bounded JSON output with exact truncation metadata', async () => {
    const stdout = new MemoryWritable()
    const completion: ExecutionCompletion = {
      outcome: { kind: 'remote_result', result },
      output: {
        result,
        stdout: {
          encoding: 'base64',
          data: 'YWJj',
          retainedBytes: 3,
          totalBytes: 100,
          truncated: true,
        },
        stderr: {
          encoding: 'base64',
          data: '',
          retainedBytes: 0,
          totalBytes: 0,
          truncated: false,
        },
      },
    }
    await writeExecutionCompletion('json', completion, stdout, new MemoryWritable())
    expect(JSON.parse(stdout.text())).toMatchObject({
      outcome: 'remote_result',
      result: { exitCode: 125 },
      stdout: { retainedBytes: 3, totalBytes: 100, truncated: true },
    })
  })

  it('uses a safe infrastructure envelope without serializing raw errors', async () => {
    const stdout = new MemoryWritable()
    await writeExecutionCompletion(
      'json',
      {
        outcome: {
          kind: 'infrastructure_error',
          error: new ExecutionInfrastructureError(
            'provider_start',
            new Error('Bearer private-secret'),
          ),
        },
        output: null,
      },
      stdout,
      new MemoryWritable(),
    )
    expect(stdout.text()).toBe(
      '{"schemaVersion":1,"kind":"result","outcome":"infrastructure_error"}\n',
    )
  })
})

import { describe, expect, it } from 'vitest'
import {
  decodeHelperRequest,
  decodeHelperEventFrames,
  encodeHelperEventFrame,
  encodeHelperRequest,
  HelperProtocolError,
  HelperRequestSchema,
  helperSpawnArguments,
  MAX_HELPER_REQUEST_BYTES,
} from '../../src/execution/helper-protocol.js'

const request = HelperRequestSchema.parse({
  version: 1,
  executionId: '12345678-1234-4234-8234-123456789abc',
  command: {
    mode: 'argv',
    argv: ['tool', '', 'a b', '日本語🙂', '$(touch x)', 'a; b', '"quoted"'],
  },
  workingDirectory: '/workspace',
  environment: { LANG: 'C.UTF-8' },
  timeoutMilliseconds: 1000,
})

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values
}

describe('execution helper protocol', () => {
  it('preserves exact argv through every possible two-chunk boundary', async () => {
    const frame = encodeHelperRequest(request)
    for (let split = 0; split <= frame.length; split++) {
      expect(
        await decodeHelperRequest(chunks(frame.subarray(0, split), frame.subarray(split))),
      ).toEqual(request)
    }
    expect(helperSpawnArguments(request, false)).toEqual({
      executable: 'tool',
      args: request.command.mode === 'argv' ? request.command.argv.slice(1) : [],
    })
  })

  it('rejects every truncated prefix, trailing bytes, and multiple requests', async () => {
    const frame = encodeHelperRequest(request)
    for (let length = 0; length < frame.length; length++) {
      await expect(decodeHelperRequest(chunks(frame.subarray(0, length)))).rejects.toBeInstanceOf(
        HelperProtocolError,
      )
    }
    await expect(decodeHelperRequest(chunks(frame, Uint8Array.of(0)))).rejects.toBeInstanceOf(
      HelperProtocolError,
    )
    await expect(decodeHelperRequest(chunks(frame, frame))).rejects.toBeInstanceOf(
      HelperProtocolError,
    )
  })

  it('rejects oversized advertised frames before reading their body', async () => {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(MAX_HELPER_REQUEST_BYTES + 1)
    let bodyRequested = false
    async function* input() {
      yield header
      bodyRequested = true
      yield Buffer.alloc(1)
    }
    await expect(decodeHelperRequest(input())).rejects.toBeInstanceOf(HelperProtocolError)
    expect(bodyRequested).toBe(false)
  })

  it('rejects invalid UTF-8 and unknown versions without echoing input', async () => {
    const invalid = Uint8Array.of(0, 0, 0, 1, 255)
    await expect(decodeHelperRequest(chunks(invalid))).rejects.toThrow(
      'Invalid or unsupported execution helper request',
    )
    expect(() => encodeHelperRequest({ ...request, version: 2 })).toThrow(HelperProtocolError)
    expect(() =>
      encodeHelperRequest({ ...request, environment: { API_KEY: 'private-value' } }),
    ).toThrow('Invalid or unsupported execution helper request')
  })

  it('gates explicit shell mode and passes its script as one argument', () => {
    const shell = HelperRequestSchema.parse({
      ...request,
      command: { mode: 'shell', shell: 'echo "$HOME"' },
    })
    expect(() => helperSpawnArguments(shell, false)).toThrow(HelperProtocolError)
    expect(helperSpawnArguments(shell, true)).toEqual({
      executable: '/bin/bash',
      args: ['-lc', 'echo "$HOME"'],
    })
  })

  it('round-trips binary event frames across arbitrary transport chunks', async () => {
    const values = [
      {
        version: 1 as const,
        type: 'stdout' as const,
        executionId: request.executionId,
        sequence: 1,
        timestamp: '2026-09-08T12:00:00.000Z',
        data: Buffer.from(Uint8Array.of(0, 255, 1, 2, 3)).toString('base64'),
      },
      {
        version: 1 as const,
        type: 'stderr' as const,
        executionId: request.executionId,
        sequence: 2,
        timestamp: '2026-09-08T12:00:00.001Z',
        data: Buffer.from('🙂').toString('base64'),
      },
    ]
    const encoded = Buffer.concat(values.map((value) => encodeHelperEventFrame(value)))
    for (let split = 0; split <= encoded.byteLength; split++) {
      const decoded = []
      for await (const value of decodeHelperEventFrames(
        chunks(encoded.subarray(0, split), encoded.subarray(split)),
      )) {
        decoded.push(value)
      }
      expect(decoded).toEqual(values)
    }
  })

  it('rejects truncated and oversized event frames', async () => {
    const encoded = encodeHelperEventFrame({
      version: 1,
      type: 'started',
      executionId: request.executionId,
      sequence: 0,
      timestamp: '2026-09-08T12:00:00.000Z',
    })
    async function collect(input: AsyncIterable<Uint8Array>) {
      for await (const _value of decodeHelperEventFrames(input)) {
        // Drain the decoder to surface terminal framing errors.
      }
    }
    await expect(collect(chunks(encoded.subarray(0, -1)))).rejects.toBeInstanceOf(
      HelperProtocolError,
    )
    const header = Buffer.alloc(4)
    header.writeUInt32BE(MAX_HELPER_REQUEST_BYTES + 1)
    await expect(collect(chunks(header))).rejects.toBeInstanceOf(HelperProtocolError)
  })
})

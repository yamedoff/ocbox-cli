import { describe, expect, it } from 'vitest'
import {
  ExecEventSchema,
  ExecResultSchema,
  ExecutionSchema,
  ReadFileResultSchema,
  ShellCommandSchema,
  StructuredArgvCommandSchema,
} from '../../src/contracts.js'
import { ids, timestamps } from './test-data.js'

describe('execution contract', () => {
  it('keeps structured argv separate from explicit shell mode', () => {
    const argv = StructuredArgvCommandSchema.parse({
      mode: 'argv',
      argv: ['printf', '%s', 'hello world'],
    })
    expect(argv.argv).toEqual(['printf', '%s', 'hello world'])
    expect(Object.isFrozen(argv.argv)).toBe(true)

    const shell = ShellCommandSchema.parse({ mode: 'shell', shell: 'printf "%s" "$VALUE"' })
    expect(shell.mode).toBe('shell')
    expect(StructuredArgvCommandSchema.safeParse(shell).success).toBe(false)
    expect(ShellCommandSchema.safeParse(argv).success).toBe(false)
    expect(StructuredArgvCommandSchema.safeParse({ mode: 'argv', argv: ['   '] }).success).toBe(
      false,
    )
    expect(ShellCommandSchema.safeParse({ mode: 'shell', shell: 'echo\0unsafe' }).success).toBe(
      false,
    )
  })

  it('represents a remote nonzero exit as an ExecResult', () => {
    const result = ExecResultSchema.parse({
      exitCode: 23,
      stdout: new Uint8Array([111, 107]),
      stderr: new Uint8Array([102, 97, 105, 108]),
      timedOut: false,
      cancelled: false,
      signal: null,
      startedAt: timestamps.observed,
      completedAt: timestamps.completed,
    })
    const execution = ExecutionSchema.parse({
      id: ids.execution,
      operationId: ids.operation,
      sandboxId: ids.sandbox,
      command: { mode: 'argv', argv: ['test-runner'] },
      status: 'completed',
      result,
      createdAt: timestamps.created,
      startedAt: timestamps.observed,
      completedAt: timestamps.completed,
    })

    expect(execution.status).toBe('completed')
    expect(execution.result?.exitCode).toBe(23)
  })

  it('streams ordered byte chunks without forcing UTF-8 decoding', () => {
    const invalidUtf8 = new Uint8Array([0, 255, 254, 128])
    const event = ExecEventSchema.parse({
      type: 'stdout',
      executionId: ids.execution,
      sequence: 0,
      timestamp: timestamps.observed,
      data: invalidUtf8,
    })
    expect(event.type).toBe('stdout')
    if (event.type === 'stdout') expect(event.data).toEqual(invalidUtf8)
  })

  it('rejects completed executions without matching start and result evidence', () => {
    const result = {
      exitCode: 0,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      timedOut: false,
      cancelled: false,
      signal: null,
      startedAt: timestamps.observed,
      completedAt: timestamps.completed,
    }
    const completed = {
      id: ids.execution,
      operationId: ids.operation,
      sandboxId: ids.sandbox,
      command: { mode: 'argv', argv: ['true'] },
      status: 'completed',
      result,
      createdAt: timestamps.created,
      startedAt: timestamps.observed,
      completedAt: timestamps.completed,
    } as const

    expect(ExecutionSchema.safeParse({ ...completed, startedAt: null }).success).toBe(false)
    expect(
      ExecutionSchema.safeParse({
        ...completed,
        result: { ...result, completedAt: timestamps.observed },
      }).success,
    ).toBe(false)
  })
})

describe('binary-safe file contract', () => {
  it('round-trips arbitrary bytes without string conversion', () => {
    const data = new Uint8Array([0, 255, 1, 254, 13, 10])
    const result = ReadFileResultSchema.parse({
      entry: {
        path: '/workspace/blob.bin',
        kind: 'file',
        sizeBytes: data.byteLength,
        mode: 0o640,
        modifiedAt: timestamps.observed,
        sha256: 'a'.repeat(64),
        symlinkTarget: null,
      },
      data,
    })

    expect(result.data).toBeInstanceOf(Uint8Array)
    expect([...result.data]).toEqual([0, 255, 1, 254, 13, 10])
  })

  it('rejects impossible entry kinds on read results', () => {
    expect(
      ReadFileResultSchema.safeParse({
        entry: {
          path: '/workspace',
          kind: 'directory',
          sizeBytes: 0,
          mode: 0o750,
          modifiedAt: timestamps.observed,
          sha256: null,
          symlinkTarget: '/workspace/target',
        },
        data: new Uint8Array(),
      }).success,
    ).toBe(false)
  })
})

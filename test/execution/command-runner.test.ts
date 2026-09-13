import { describe, expect, it, vi } from 'vitest'
import type {
  ExecHandle,
  Operation,
  OperationContext,
  ProviderCapabilities,
  SandboxProvider,
} from '../../src/contracts.js'
import { OcboxError } from '../../src/errors/index.js'
import {
  runExecutionCommand,
  runExecutionCommandResult,
  type ExecutionInterruptSource,
  type ExecutionWritable,
} from '../../src/execution/index.js'
import { FakeProviderExecution } from '../../src/execution/fake-provider-execution.js'
import { ids, sandbox, session } from '../contracts/test-data.js'

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

class TestInterrupts implements ExecutionInterruptSource {
  listener: (() => void) | undefined

  subscribe(listener: () => void): () => void {
    this.listener = listener
    return () => {
      this.listener = undefined
    }
  }

  fire(): void {
    this.listener?.()
  }
}

const capabilities: ProviderCapabilities = {
  runtimeClasses: ['container'],
  lifecycle: {
    preservesFilesystemOnStop: true,
    supportsMemoryPause: true,
    supportsArchive: false,
  },
  execution: { streaming: true, cancellation: true },
  files: {
    read: false,
    write: false,
    list: false,
    stat: false,
    makeDirectory: false,
    remove: false,
    move: false,
    checksum: false,
  },
  previews: { supported: false, authenticated: false, http: false, websocket: false },
  egressModes: ['open'],
  metadataSearch: true,
  secretExposureModes: ['unsupported'],
  limits: {
    maxCpuMillicores: null,
    maxMemoryBytes: null,
    maxDiskBytes: null,
    maxExecutionMilliseconds: 10_000,
    maxFileBytes: null,
    maxConcurrentExecutions: 1,
    maxSandboxes: null,
    maxSandboxesPerSession: 1,
  },
}

function target(execution = new FakeProviderExecution({ sessionIdForSandbox: () => ids.session })) {
  return {
    session,
    sandbox,
    capabilities,
    provider: { exec: execution } as unknown as SandboxProvider,
  }
}

function io() {
  return { stdout: new MemoryWritable(), stderr: new MemoryWritable() }
}

describe('execution command runner', () => {
  it('preserves a remote exit 125 and disambiguates it in JSON', async () => {
    const output = io()
    const exitCode = await runExecutionCommand(
      ['--json', '--', process.execPath, '-e', 'process.exit(125)'],
      () => target(),
      output,
    )
    expect(exitCode).toBe(125)
    expect(JSON.parse(output.stdout.text())).toMatchObject({
      outcome: 'remote_result',
      result: { exitCode: 125 },
    })
  })

  it('maps a missing executable to a safe before-start infrastructure result', async () => {
    const output = io()
    const exitCode = await runExecutionCommand(
      ['--json', '--', 'opencloudbox-definitely-missing-executable'],
      () => target(),
      output,
    )
    expect(exitCode).toBe(125)
    expect(output.stderr.text()).toBe('')
    expect(output.stdout.text()).toBe(
      '{"schemaVersion":1,"kind":"result","outcome":"infrastructure_error"}\n',
    )
  })

  it('fails closed with exit 2 for a pre-start resolution failure when asked (N2)', async () => {
    const output = io()
    const exitCode = await runExecutionCommand(
      ['--json', '--', 'tool'],
      () => {
        throw new OcboxError({
          code: 'ENVIRONMENT_NOT_FOUND',
          message: 'Session was not found',
          requestId: ids.request,
        })
      },
      output,
      { failClosedBeforeStart: true },
    )
    expect(exitCode).toBe(2)
    expect(JSON.parse(output.stdout.text())).toMatchObject({
      outcome: 'infrastructure_error',
      error: { code: 'ENVIRONMENT_NOT_FOUND' },
    })
  })

  it('fails closed with exit 2 for an invalid exec argument when asked (N2)', async () => {
    const output = io()
    const exitCode = await runExecutionCommand(
      ['--json', '--session', 'sess-1', '--shell', 'echo hi'],
      () => target(),
      output,
      { failClosedBeforeStart: true },
    )
    expect(exitCode).toBe(2)
  })

  it('keeps an honest remote result despite the fail-closed option (N2)', async () => {
    const output = io()
    const exitCode = await runExecutionCommand(
      ['--json', '--', process.execPath, '-e', 'process.exit(125)'],
      () => target(),
      output,
      { failClosedBeforeStart: true },
    )
    expect(exitCode).toBe(125)
    expect(JSON.parse(output.stdout.text())).toMatchObject({
      outcome: 'remote_result',
      result: { exitCode: 125 },
    })
  })

  it('surfaces a typed, actionable error when target resolution fails before start', async () => {
    const output = io()
    const exitCode = await runExecutionCommand(
      ['--json', '--', 'tool'],
      () => {
        throw new OcboxError({
          code: 'INVALID_STATE',
          message: 'Session is paused; run ocbox start',
          requestId: ids.request,
        })
      },
      output,
    )
    expect(exitCode).toBe(125)
    expect(JSON.parse(output.stdout.text())).toMatchObject({
      outcome: 'infrastructure_error',
      error: { code: 'INVALID_STATE', message: 'Session is paused; run ocbox start' },
    })
  })

  it('surfaces an actionable detail for an invalid exec argument', async () => {
    const jsonOutput = io()
    const jsonExit = await runExecutionCommand(
      ['--json', '--frobnicate', '--', 'tool'],
      () => target(),
      jsonOutput,
    )
    expect(jsonExit).toBe(125)
    expect(JSON.parse(jsonOutput.stdout.text())).toMatchObject({
      outcome: 'infrastructure_error',
      error: { code: 'EXECUTION_ARGUMENT_INVALID', message: expect.any(String) },
    })

    const humanOutput = io()
    const humanExit = await runExecutionCommand(
      ['--bogus', '--', 'tool'],
      () => target(),
      humanOutput,
    )
    expect(humanExit).toBe(125)
    expect(humanOutput.stderr.text()).toContain('Unknown exec option')
  })

  it('keeps the generic unexplained envelope for an untyped resolution failure', async () => {
    const output = io()
    const exitCode = await runExecutionCommand(
      ['--json', '--', 'tool'],
      () => Promise.reject(new Error('raw provider failure with sensitive details')),
      output,
    )
    expect(exitCode).toBe(125)
    expect(JSON.parse(output.stdout.text())).toEqual({
      schemaVersion: 1,
      kind: 'result',
      outcome: 'infrastructure_error',
    })
    expect(output.stderr.text()).toBe('')
  })

  it('first interrupt requests cancellation and returns the typed cancelled outcome', async () => {
    const output = io()
    const interrupts = new TestInterrupts()
    const running = runExecutionCommand(
      ['--json', '--', process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      () => target(),
      output,
      { interrupts },
    )
    while (interrupts.listener === undefined) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    interrupts.fire()
    expect(await running).toBe(130)
    expect(JSON.parse(output.stdout.text())).toMatchObject({ outcome: 'cancelled' })
  })

  it('second interrupt returns 130 without waiting for a stuck cancellation call', async () => {
    const output = io()
    const interrupts = new TestInterrupts()
    const never = new Promise<never>(() => {})
    const execute = vi.fn(async (context: OperationContext): Promise<ExecHandle> => {
      async function* events() {
        yield {
          type: 'started' as const,
          executionId: ids.execution,
          sequence: 0,
          timestamp: session.createdAt,
        }
        await never
      }
      return {
        execution: {
          id: ids.execution,
          operationId: context.operationId,
          sandboxId: ids.sandbox,
          command: { mode: 'argv', argv: ['tool'] },
          status: 'running',
          result: null,
          createdAt: session.createdAt,
          startedAt: session.createdAt,
          completedAt: null,
        },
        events: events(),
        result: never,
      }
    })
    const provider = {
      exec: { execute, cancel: vi.fn<() => Promise<Operation>>(() => never) },
    } as unknown as SandboxProvider
    const running = runExecutionCommand(
      ['--jsonl', '--', 'tool'],
      () => ({ ...target(), provider }),
      output,
      { interrupts },
    )
    while (interrupts.listener === undefined) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    interrupts.fire()
    interrupts.fire()
    expect(await running).toBe(130)
    const lines = output.stdout
      .text()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    // The final result envelope terminates the stream; no event may follow it.
    expect(lines.at(-1)).toEqual({
      schemaVersion: 1,
      kind: 'result',
      outcome: 'cancelled',
    })
    expect(lines.filter((line) => line['kind'] === 'event')).toHaveLength(1)
  })

  it('surfaces the honest structured result for a started remote run', async () => {
    const output = io()
    const result = await runExecutionCommandResult(
      ['--json', '--', process.execPath, '-e', 'process.exit(2)'],
      () => target(),
      output,
    )
    expect(result.started).toBe(true)
    expect(result.exitCode).toBe(2)
    expect(result.outcome.kind).toBe('remote_result')
  })

  it('marks a pre-start failure started:false while keeping the honest exit code', async () => {
    const output = io()
    const result = await runExecutionCommandResult(
      ['--json', '--', 'tool'],
      () => {
        throw new OcboxError({
          code: 'ENVIRONMENT_NOT_FOUND',
          message: 'Session was not found',
          requestId: ids.request,
        })
      },
      output,
      { failClosedBeforeStart: true },
    )
    expect(result.started).toBe(false)
    expect(result.exitCode).toBe(125)
    expect(result.outcome.kind).toBe('infrastructure_error')
  })
})

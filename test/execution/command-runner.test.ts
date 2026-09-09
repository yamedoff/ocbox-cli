import { describe, expect, it, vi } from 'vitest'
import type {
  ExecHandle,
  Operation,
  OperationContext,
  ProviderCapabilities,
  SandboxProvider,
} from '../../src/contracts.js'
import {
  runExecutionCommand,
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
    expect(
      output.stdout
        .text()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toContainEqual({
      schemaVersion: 1,
      kind: 'result',
      outcome: 'cancelled',
    })
  })
})

import { describe, expect, it, vi } from 'vitest'
import type {
  ExecHandle,
  Operation,
  ProviderCapabilities,
  SandboxProvider,
} from '../../src/contracts.js'
import { parseExecArguments } from '../../src/execution/cli-arguments.js'
import { FakeProviderExecution } from '../../src/execution/fake-provider-execution.js'
import { ExecutionInfrastructureError } from '../../src/execution/exit-policy.js'
import { ExecutionContextError, ExecutionService } from '../../src/execution/service.js'
import { ids, sandbox, session } from '../contracts/test-data.js'

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

describe('provider-neutral execution service', () => {
  it('streams through the provider port and preserves a remote nonzero result', async () => {
    const events: string[] = []
    const run = await new ExecutionService().start(
      target(),
      parseExecArguments([
        '--jsonl',
        '--',
        process.execPath,
        '-e',
        "process.stdout.write('ok'); process.stderr.write('warn'); process.exit(23)",
      ]),
      async (event) => {
        events.push(event.type)
      },
    )
    const completion = await run.completion
    expect(completion.outcome).toMatchObject({ kind: 'remote_result', result: { exitCode: 23 } })
    expect(events[0]).toBe('started')
    expect(events.at(-1)).toBe('completed')
    expect(completion.output?.stdout.totalBytes).toBe(2)
    expect(completion.output?.stderr.totalBytes).toBe(4)
  })

  it('first interrupt requests provider cancellation and the second requests safe CLI exit', async () => {
    const run = await new ExecutionService().start(
      target(),
      parseExecArguments(['--', process.execPath, '-e', 'setInterval(() => {}, 1000)']),
      async () => {},
    )
    expect(await run.interrupt()).toBe('cancel_requested')
    expect(await run.interrupt()).toBe('force_exit')
    expect((await run.completion).outcome.kind).toBe('cancelled')
  })

  it('keeps the remote terminal result authoritative when cancellation fails', async () => {
    const execution = new FakeProviderExecution({
      sessionIdForSandbox: () => ids.session,
      rejectCancellation: true,
    })
    const run = await new ExecutionService().start(
      target(execution),
      parseExecArguments(['--', process.execPath, '-e', 'process.exit(7)']),
      async () => {},
    )
    expect(await run.interrupt()).toBe('cancel_requested')
    expect(await run.completion).toMatchObject({
      outcome: { kind: 'remote_result', result: { exitCode: 7 } },
    })
  })

  it('classifies a disconnected event stream as infrastructure failure', async () => {
    const execute = vi.fn(
      async (context: Parameters<SandboxProvider['exec']['execute']>[0]): Promise<ExecHandle> => {
        async function* events() {
          yield {
            type: 'started' as const,
            executionId: ids.execution,
            sequence: 0,
            timestamp: session.createdAt,
          }
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
          result: new Promise(() => {}),
        }
      },
    )
    const provider = {
      exec: { execute, cancel: vi.fn<() => Promise<Operation>>() },
    } as unknown as SandboxProvider
    const run = await new ExecutionService().start(
      { ...target(), provider },
      parseExecArguments(['--', 'tool']),
      async () => {},
    )
    expect((await run.completion).outcome.kind).toBe('infrastructure_error')
  })

  it('returns a typed failure when the provider cannot start execution', async () => {
    const provider = {
      exec: { execute: vi.fn().mockRejectedValue(new Error('Bearer private-secret')) },
    } as unknown as SandboxProvider
    await expect(
      new ExecutionService().start(
        { ...target(), provider },
        parseExecArguments(['--', 'tool']),
        async () => {},
      ),
    ).rejects.toMatchObject({
      code: 'EXECUTION_INFRASTRUCTURE_ERROR',
      stage: 'provider_start',
      message: 'Execution infrastructure failed',
    })
  })

  it('classifies disagreement between the terminal event and result promise', async () => {
    const execution = new FakeProviderExecution({ sessionIdForSandbox: () => ids.session })
    const provider = {
      exec: {
        execute: async (...input: Parameters<typeof execution.execute>) => {
          const handle = await execution.execute(...input)
          return { ...handle, result: handle.result.then((value) => ({ ...value, exitCode: 99 })) }
        },
        cancel: execution.cancel.bind(execution),
      },
    } as unknown as SandboxProvider
    const run = await new ExecutionService().start(
      { ...target(), provider },
      parseExecArguments(['--', process.execPath, '-e', 'process.exit(7)']),
      async () => {},
    )
    await expect(run.completion).resolves.toMatchObject({
      outcome: {
        kind: 'infrastructure_error',
        error: expect.any(ExecutionInfrastructureError),
      },
    })
  })

  it.each([
    { session: { ...session, state: 'paused' as const }, message: /must be active/ },
    {
      sandbox: {
        ...sandbox,
        lifecycle: { ...sandbox.lifecycle, normalizedState: 'stopped' as const },
      },
      message: /ready running sandbox/,
    },
    {
      capabilities: { ...capabilities, execution: { streaming: false, cancellation: false } },
      message: /streaming execution/,
    },
    {
      capabilities: { ...capabilities, execution: { streaming: true, cancellation: false } },
      message: /execution cancellation/,
    },
    {
      session: { ...session, bindings: [] },
      message: /valid primary Sandbox/,
    },
  ])('rejects invalid context before provider mutation', async (override) => {
    const execute = vi.fn()
    const base = target()
    const attempted = new ExecutionService().start(
      { ...base, ...override, provider: { exec: { execute } } as unknown as SandboxProvider },
      parseExecArguments(['--', 'tool']),
      async () => {},
    )
    await expect(attempted).rejects.toBeInstanceOf(ExecutionContextError)
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects an explicit Session that differs from the resolved target', async () => {
    const execute = vi.fn()
    await expect(
      new ExecutionService().start(
        { ...target(), provider: { exec: { execute } } as unknown as SandboxProvider },
        parseExecArguments(['--session', '99999999-9999-4999-8999-999999999999', '--', 'tool']),
        async () => {},
      ),
    ).rejects.toThrow(/requested Session does not match/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('validates timeout and shell compatibility before provider mutation', async () => {
    const execute = vi.fn()
    const provider = { exec: { execute } } as unknown as SandboxProvider
    const effective = sandbox.specification.effective
    if (effective === null) throw new TypeError('Test fixture requires an effective Sandbox spec')
    await expect(
      new ExecutionService().start(
        { ...target(), provider },
        parseExecArguments(['--timeout', '10001', '--', 'tool']),
        async () => {},
      ),
    ).rejects.toThrow(/provider limit/)
    await expect(
      new ExecutionService().start(
        {
          ...target(),
          provider,
          sandbox: {
            ...sandbox,
            specification: {
              ...sandbox.specification,
              effective: { ...effective, operatingSystem: 'windows' },
            },
          },
        },
        parseExecArguments(['--shell', 'echo ok']),
        async () => {},
      ),
    ).rejects.toThrow(/Bash-compatible/)
    expect(execute).not.toHaveBeenCalled()
  })
})

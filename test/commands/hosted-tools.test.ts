import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthMetadataStore } from '../../src/auth/metadata.js'
import {
  createCredentialStore,
  defaultCredentialKey,
  resolveAuthEndpoints,
} from '../../src/auth/runtime.js'
import { DEFAULT_PROJECT_CONFIG } from '../../src/cli/runtime.js'
import ExecutionGet from '../../src/commands/execution/get.js'
import GpuCheck from '../../src/commands/gpu/check.js'
import OperationCancel from '../../src/commands/operation/cancel.js'
import OperationGet from '../../src/commands/operation/get.js'
import PreviewCreate from '../../src/commands/preview/create.js'
import UsageList from '../../src/commands/usage/list.js'
import WalletGet from '../../src/commands/wallet/get.js'
import { UtcTimestampSchema } from '../../src/domain/timestamps.js'
import { DEFAULT_API_URL } from '../../src/providers/ocbox/defaults.js'

const originalExitCode = process.exitCode
const originalEnvironment = { ...process.env }
const roots: string[] = []
let root: string
let state: string
let config: string
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

function output(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join('')
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' },
  })
}

async function logIn(): Promise<void> {
  const endpoints = resolveAuthEndpoints({ 'api-url': DEFAULT_API_URL }, {})
  const key = defaultCredentialKey()
  const credential = {
    accessToken: 'fixture-access-'.padEnd(48, 'a'),
    refreshToken: 'fixture-refresh-'.padEnd(48, 'r'),
    expiresAt: UtcTimestampSchema.parse(new Date(Date.now() + 3_600_000).toISOString()),
    scopes: [...endpoints.scopes],
    tokenType: 'Bearer' as const,
  }
  await createCredentialStore().set(key, credential)
  await new AuthMetadataStore(join(state, 'auth.json')).save({
    schemaVersion: 1,
    issuer: endpoints.issuer,
    clientId: endpoints.clientId,
    audience: 'cli',
    scopes: credential.scopes,
    expiresAt: credential.expiresAt,
    identity: key,
    updatedAt: UtcTimestampSchema.parse(new Date().toISOString()),
  })
}

const runArguments = () => ['--config', config, '--state-dir', state, '--api-url', DEFAULT_API_URL]

beforeEach(async () => {
  process.exitCode = 0
  root = await mkdtemp(join(tmpdir(), 'ocbox-hosted-tools-'))
  roots.push(root)
  process.env['HOME'] = join(root, 'home')
  process.env['XDG_CONFIG_HOME'] = join(root, 'config')
  process.env['XDG_STATE_HOME'] = join(root, 'state-home')
  process.env['APPDATA'] = join(root, 'appdata')
  process.env['LOCALAPPDATA'] = join(root, 'localappdata')
  process.env['USERPROFILE'] = join(root, 'userprofile')
  state = join(root, 'state')
  config = join(root, 'opencloudbox.toml')
  await writeFile(config, DEFAULT_PROJECT_CONFIG.replace('name = "fake"', 'name = "ocbox"'))
  await logIn()
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
})

afterEach(async () => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  process.exitCode = originalExitCode
  for (const name of Object.keys(process.env)) {
    if (!(name in originalEnvironment)) delete process.env[name]
  }
  Object.assign(process.env, originalEnvironment)
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const now = () => new Date().toISOString()

function operation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'op_1',
    createdAt: now(),
    updatedAt: now(),
    kind: 'session.start',
    projectId: 'prj_1',
    sessionId: 'ses_1',
    state: 'succeeded',
    progress: 100,
    requestId: 'request-1',
    error: null,
    resource: null,
    ...overrides,
  }
}

function execution(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'exe_1',
    createdAt: now(),
    updatedAt: now(),
    sessionId: 'ses_1',
    sandboxId: 'sbx_1',
    state: 'pending',
    command: 'echo hello',
    exitCode: null,
    failureKind: null,
    failure: null,
    truncated: false,
    outputBytes: 0,
    outputLimitBytes: 1_048_576,
    ...overrides,
  }
}

describe('gpu check command', () => {
  it('sends the GPU query in the MCP units and prints the answer', async () => {
    const calls: { path: string; query: Record<string, string> }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = new URL(String(input))
        calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) })
        return jsonResponse({
          ok: true,
          sizeId: 'gpu-small',
          gpu: { type: 'gpu-a', count: 1 },
          maxLifetimeSeconds: 3600,
          price: { microUsdPerHour: 1_500_000 },
          capacityKnown: true,
          lifetimeSeconds: 3600,
          message: 'This box is available.',
        })
      }),
    )

    await GpuCheck.run(
      [
        ...runArguments(),
        '--gpu-type',
        'gpu-a',
        '--gpu-count',
        '1',
        '--lifetime-seconds',
        '3600',
        '--cpu',
        '8',
        '--memory-mib',
        '65536',
        '--disk-gib',
        '100',
        '--json',
      ],
      { root: process.cwd() },
    )

    expect(process.exitCode ?? 0).toBe(0)
    expect(calls).toEqual([
      {
        path: '/v1/gpu-check',
        query: {
          gpuType: 'gpu-a',
          gpuCount: '1',
          lifetimeSeconds: '3600',
          cpu: '8',
          memoryMib: '65536',
          diskGib: '100',
        },
      },
    ])
    const printed = JSON.parse(output(stdoutSpy))
    expect(printed.data.gpuCheck).toMatchObject({ ok: true, sizeId: 'gpu-small' })
  })

  it('shows every problem reason when the GPU box is not possible', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: false,
          reason: 'gpu_unavailable',
          message: 'No box of this size is free right now',
          problems: [
            {
              field: 'gpu',
              reason: 'gpu_unavailable',
              message: 'No box of this size is free right now',
              requested: '1 x gpu-a',
              availableNow: ['gpu-b'],
            },
          ],
          alternatives: [
            {
              sizeId: 'gpu-small-b',
              gpu: { type: 'gpu-b', count: 1 },
              maxLifetimeSeconds: 3600,
              price: { microUsdPerHour: 1_500_000 },
              capacityKnown: true,
            },
          ],
        }),
      ),
    )

    await GpuCheck.run([...runArguments(), '--gpu-type', 'gpu-a', '--gpu-count', '1'], {
      root: process.cwd(),
    })

    expect(process.exitCode ?? 0).toBe(0)
    expect(output(stdoutSpy)).toContain('reason gpu_unavailable')
    expect(output(stdoutSpy)).toContain('Alternatives: gpu-small-b')
  })
})

describe('execution get command', () => {
  it('reads one execution and its result once terminal', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const path = new URL(String(input)).pathname
        calls.push(path)
        if (path === '/v1/executions/exe_1') {
          return jsonResponse(
            execution({ state: 'completed', exitCode: 0, outputBytes: 5, truncated: false }),
          )
        }
        return jsonResponse({
          kind: 'command',
          exitCode: 0,
          stdout: 'hello',
          stderr: '',
          truncated: false,
          outputBytes: 5,
          outputLimitBytes: 1_048_576,
          encoding: { stdout: 'utf-8', stderr: 'utf-8' },
        })
      }),
    )

    await ExecutionGet.run([...runArguments(), 'exe_1', '--json'], { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    expect(calls).toEqual(['/v1/executions/exe_1', '/v1/executions/exe_1/result'])
    const printed = JSON.parse(output(stdoutSpy))
    expect(printed.data.execution).toMatchObject({ id: 'exe_1', state: 'completed' })
    expect(printed.data.result).toMatchObject({ kind: 'command', exitCode: 0 })
    expect(printed.data.cursor).toBeNull()
  })

  it('returns the execution while it is still pending', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(execution())),
    )

    await ExecutionGet.run([...runArguments(), 'exe_1', '--json'], { root: process.cwd() })

    const printed = JSON.parse(output(stdoutSpy))
    expect(printed.data.execution.state).toBe('pending')
    expect(printed.data.cursor).toBe('exe_1')
    expect(printed.data.result).toBeUndefined()
  })
})

describe('operation get command', () => {
  it('reads one operation and shows its stored failure reason', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        calls.push(new URL(String(input)).pathname)
        return jsonResponse(
          operation({
            state: 'failed',
            progress: 40,
            error: {
              code: 'PROVIDER_TIMEOUT',
              message: 'The provider did not answer',
              reason: 'provider_timeout',
            },
          }),
        )
      }),
    )

    await OperationGet.run([...runArguments(), 'op_1'], { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    expect(calls).toEqual(['/v1/operations/op_1'])
    expect(output(stdoutSpy)).toBe(
      'Operation op_1: failed (session.start, 40%)\nReason provider_timeout.\n',
    )
  })
})

describe('operation cancel command', () => {
  it('posts the cancellation with an idempotency key', async () => {
    const calls: { method?: string; path: string; key: string | null }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input))
        calls.push({
          ...(init?.method === undefined ? {} : { method: init.method }),
          path: url.pathname,
          key: new Headers(init?.headers).get('idempotency-key'),
        })
        return jsonResponse(operation({ state: 'cancelled', progress: 0 }), 202)
      }),
    )

    await OperationCancel.run(
      [...runArguments(), 'op_1', '--idempotency-key', 'cancel-operation-1', '--json'],
      { root: process.cwd() },
    )

    expect(process.exitCode ?? 0).toBe(0)
    expect(calls).toEqual([
      { method: 'POST', path: '/v1/operations/op_1/cancel', key: 'cancel-operation-1' },
    ])
    const printed = JSON.parse(output(stdoutSpy))
    expect(printed.data.operation.state).toBe('cancelled')
  })

  it('shows the server reason code when the operation cannot be cancelled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 'OPERATION_NOT_CANCELLABLE',
              reasonCode: 'api_operation_not_cancellable',
              message: 'Completed operation cannot be cancelled',
              nextStep: 'Wait for the operation to finish; it cannot be cancelled.',
            },
            requestId: 'request-1',
          },
          409,
        ),
      ),
    )

    await OperationCancel.run([...runArguments(), 'op_1'], { root: process.cwd() })

    expect(process.exitCode).toBe(1)
    expect(output(stderrSpy)).toContain('Reason api_operation_not_cancellable.')
    expect(output(stderrSpy)).toContain('Next: Wait for the operation to finish')
  })
})

describe('preview create command', () => {
  it('creates a preview with the session port and TTL in the MCP units', async () => {
    let body: unknown
    const calls: { method?: string; path: string; key: string | null }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input))
        calls.push({
          ...(init?.method === undefined ? {} : { method: init.method }),
          path: url.pathname,
          key: new Headers(init?.headers).get('idempotency-key'),
        })
        body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
        return jsonResponse(
          {
            id: 'prv_1',
            createdAt: now(),
            updatedAt: now(),
            sessionId: 'ses_1',
            state: 'active',
            url: 'https://preview.example/prv_1',
            port: 8080,
            expiresAt: now(),
          },
          202,
        )
      }),
    )

    await PreviewCreate.run(
      [
        ...runArguments(),
        '--session',
        'ses_1',
        '--port',
        '8080',
        '--ttl-seconds',
        '600',
        '--idempotency-key',
        'preview-create-1',
        '--json',
      ],
      { root: process.cwd() },
    )

    expect(process.exitCode ?? 0).toBe(0)
    expect(calls).toEqual([
      { method: 'POST', path: '/v1/sessions/ses_1/previews', key: 'preview-create-1' },
    ])
    expect(body).toEqual({ port: 8080, ttlSeconds: 600 })
    const printed = JSON.parse(output(stdoutSpy))
    expect(printed.data.preview).toMatchObject({ id: 'prv_1', port: 8080 })
  })
})

describe('usage list command', () => {
  function usageEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      eventId: 'evt_1',
      ownerId: 'usr_1',
      billingMode: 'managed',
      billable: true,
      quantity: '60',
      unit: 'second',
      source: 'execution',
      windowStart: now(),
      windowEnd: now(),
      ingestedAt: now(),
      providerReportId: null,
      sessionId: 'ses_1',
      ...overrides,
    }
  }

  it('pages usage and filters by session id', async () => {
    const calls: { path: string; query: Record<string, string> }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = new URL(String(input))
        calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) })
        return jsonResponse({
          data: [usageEvent(), usageEvent({ eventId: 'evt_2', sessionId: 'ses_2' })],
          nextCursor: 'next-page',
        })
      }),
    )

    await UsageList.run(
      [...runArguments(), '--session-id', 'ses_1', '--cursor', 'page-1', '--limit', '10', '--json'],
      { root: process.cwd() },
    )

    expect(process.exitCode ?? 0).toBe(0)
    expect(calls).toEqual([{ path: '/v1/billing/usage', query: { cursor: 'page-1', limit: '10' } }])
    const printed = JSON.parse(output(stdoutSpy))
    expect(printed.data.usage).toHaveLength(1)
    expect(printed.data.usage[0].eventId).toBe('evt_1')
    expect(printed.data.nextCursor).toBe('next-page')
  })
})

describe('wallet get command', () => {
  it('reads the derived wallet balances', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        calls.push(new URL(String(input)).pathname)
        return jsonResponse({
          ownerId: 'usr_1',
          availableMicrocredits: '1200000',
          reservedMicrocredits: '0',
          consumedMicrocredits: '300000',
          expiredMicrocredits: '0',
          grantedMicrocredits: '1500000',
          adjustmentsMicrocredits: '-1000',
        })
      }),
    )

    await WalletGet.run([...runArguments(), '--json'], { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    expect(calls).toEqual(['/v1/billing/wallet'])
    const printed = JSON.parse(output(stdoutSpy))
    expect(printed.data.wallet).toMatchObject({
      availableMicrocredits: '1200000',
      consumedMicrocredits: '300000',
    })
  })
})

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OcboxApiClient } from '../../src/api/client/index.js'
import { newRequestId } from '../../src/auth/errors.js'
import { AuthMetadataStore } from '../../src/auth/metadata.js'
import {
  createCredentialStore,
  defaultCredentialKey,
  resolveAuthEndpoints,
} from '../../src/auth/runtime.js'
import { DEFAULT_PROJECT_CONFIG } from '../../src/cli/runtime.js'
import Logs from '../../src/commands/logs.js'
import { PowerShellWindowsAclProtector } from '../../src/credentials/windows-acl.js'
import { UtcTimestampSchema } from '../../src/domain/timestamps.js'
import { OcboxError } from '../../src/errors/index.js'
import { getExecutionLogs } from '../../src/hosted/execution.js'
import { DEFAULT_API_URL } from '../../src/providers/ocbox/defaults.js'

const now = () => new Date().toISOString()

function execution(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'exe_1',
    createdAt: now(),
    updatedAt: now(),
    sessionId: 'ses_1',
    sandboxId: 'sbx_1',
    state: 'completed',
    command: 'echo hello',
    exitCode: 0,
    failureKind: null,
    failure: null,
    truncated: false,
    outputBytes: 5,
    outputLimitBytes: 1_048_576,
    ...overrides,
  }
}

function commandResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'command',
    exitCode: 0,
    stdout: 'hello',
    stderr: '',
    truncated: false,
    outputBytes: 5,
    outputLimitBytes: 1_048_576,
    encoding: { stdout: 'utf-8', stderr: 'utf-8' },
    ...overrides,
  }
}

function decodeStream(stream: { data: string }): string {
  return Buffer.from(stream.data, 'base64').toString('utf8')
}

function fakeApi(options: { execution?: unknown; result?: unknown; resultError?: unknown } = {}) {
  const getExecution = vi.fn(async () => ({
    body: options.execution ?? execution(),
    meta: { requestId: 'request-1' },
  }))
  const getExecutionResult = vi.fn(async () => {
    if (options.resultError !== undefined) throw options.resultError
    return { body: options.result ?? commandResult(), meta: { requestId: 'request-1' } }
  })
  const assertSuccess = vi.fn(
    (_operation: string, response: { body: unknown; meta: { requestId: string } }) => ({
      body: response.body,
      meta: response.meta,
    }),
  )
  const api = {
    generated: { getExecution, getExecutionResult },
    assertSuccess,
  } as unknown as OcboxApiClient
  return { api, getExecution, getExecutionResult }
}

describe('getExecutionLogs', () => {
  it('returns the execution and its stored result once completed', async () => {
    const { api, getExecution, getExecutionResult } = fakeApi()

    const logs = await getExecutionLogs(api, 'exe_1')

    expect(logs.execution).toMatchObject({ id: 'exe_1', state: 'completed', exitCode: 0 })
    expect(logs.result).toMatchObject({ kind: 'command', exitCode: 0, stdout: 'hello' })
    expect(getExecution).toHaveBeenCalledWith({ path: { executionId: 'exe_1' } })
    expect(getExecutionResult).toHaveBeenCalledWith({ path: { executionId: 'exe_1' } })
  })

  it('rejects a pending execution before reading its result', async () => {
    const { api, getExecutionResult } = fakeApi({
      execution: execution({ state: 'pending', exitCode: null }),
    })

    const error = await getExecutionLogs(api, 'exe_1').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(OcboxError)
    expect(error).toMatchObject({ code: 'INVALID_STATE' })
    expect((error as OcboxError).message).toContain('exe_1 is pending')
    expect(getExecutionResult).not.toHaveBeenCalled()
  })

  it('rejects a terminal execution whose stored result is not ready yet', async () => {
    const { api } = fakeApi({
      resultError: new OcboxError({
        code: 'OPERATION_CONFLICT',
        message: 'The execution result is not ready yet',
        requestId: newRequestId(),
      }),
    })

    const error = await getExecutionLogs(api, 'exe_1').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(OcboxError)
    expect(error).toMatchObject({ code: 'OPERATION_CONFLICT' })
    expect((error as OcboxError).message).toContain('not ready yet')
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' },
  })
}

describe('logs command', () => {
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

  const runArguments = () => [
    '--config',
    config,
    '--state-dir',
    state,
    '--api-url',
    DEFAULT_API_URL,
  ]

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

  beforeEach(async () => {
    vi.spyOn(PowerShellWindowsAclProtector.prototype, 'protectAndVerify').mockResolvedValue(true)
    process.exitCode = 0
    root = await mkdtemp(join(tmpdir(), 'ocbox-logs-'))
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

  it('prints the stored stdout and stderr of a finished execution raw', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const path = new URL(String(input)).pathname
        calls.push(path)
        if (path === '/v1/executions/exe_1') {
          return jsonResponse(execution({ state: 'completed', exitCode: 0 }))
        }
        return jsonResponse(commandResult({ stdout: 'hello from the box\n', stderr: 'warning\n' }))
      }),
    )

    await Logs.run([...runArguments(), 'exe_1'], { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    expect(calls).toEqual(['/v1/executions/exe_1', '/v1/executions/exe_1/result'])
    expect(output(stdoutSpy)).toBe('hello from the box\n')
    expect(output(stderrSpy)).toBe('warning\n')
  })

  it('refuses a non-terminal execution with its state', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        calls.push(new URL(String(input)).pathname)
        return jsonResponse(execution({ state: 'running', exitCode: null }))
      }),
    )

    await Logs.run([...runArguments(), 'exe_1'], { root: process.cwd() })

    expect(process.exitCode).toBe(1)
    expect(calls).toEqual(['/v1/executions/exe_1'])
    expect(output(stdoutSpy)).toBe('')
    expect(output(stderrSpy)).toBe(
      'Execution exe_1 is running; its stored output is available after it finishes.\n',
    )
  })

  it('keeps the existing redaction in the JSON envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const path = new URL(String(input)).pathname
        if (path === '/v1/executions/exe_1') {
          return jsonResponse(execution({ state: 'completed', exitCode: 0 }))
        }
        return jsonResponse(
          commandResult({ stdout: 'raw stdout', stderr: 'warning token=supersecret' }),
        )
      }),
    )

    await Logs.run([...runArguments(), 'exe_1', '--json'], { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    const printed = JSON.parse(output(stdoutSpy))
    expect(printed.kind).toBe('result')
    expect(printed.name).toBe('execution.logs')
    expect(printed.data.execution).toMatchObject({ id: 'exe_1', state: 'completed' })
    expect(printed.data.result).toMatchObject({ kind: 'command', exitCode: 0 })
    expect(printed.data.result.stdout).toEqual({
      encoding: 'base64',
      data: Buffer.from('raw stdout', 'utf8').toString('base64'),
      retainedBytes: Buffer.byteLength('raw stdout', 'utf8'),
      totalBytes: Buffer.byteLength('raw stdout', 'utf8'),
      truncated: false,
    })
    expect(decodeStream(printed.data.result.stdout)).toBe('raw stdout')
    expect(decodeStream(printed.data.result.stderr)).toBe('warning [REDACTED]')
    const stderr = printed.data.result.stderr
    expect(stderr.retainedBytes).toBe(Buffer.byteLength('warning [REDACTED]', 'utf8'))
    expect(stderr.totalBytes).toBe(stderr.retainedBytes)
    expect(stderr.truncated).toBe(false)
  })

  it('redacts only secret-shaped values inside the stored streams', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const path = new URL(String(input)).pathname
        if (path === '/v1/executions/exe_1') {
          return jsonResponse(execution({ state: 'completed', exitCode: 0 }))
        }
        return jsonResponse(
          commandResult({
            stdout: 'hello Bearer abcdefghijklmnop\n',
            stderr: 'plain warning\n',
          }),
        )
      }),
    )

    await Logs.run([...runArguments(), 'exe_1', '--json'], { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    const printed = JSON.parse(output(stdoutSpy))
    expect(decodeStream(printed.data.result.stdout)).toBe('hello [REDACTED]\n')
    expect(decodeStream(printed.data.result.stderr)).toBe('plain warning\n')
  })

  it('keeps the stream counters consistent with redaction and truncation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const path = new URL(String(input)).pathname
        if (path === '/v1/executions/exe_1') {
          return jsonResponse(execution({ state: 'completed', exitCode: 0 }))
        }
        return jsonResponse(
          commandResult({
            stdout: 'token=supersecret',
            stderr: '',
            truncated: true,
            outputBytes: 200_000,
            outputLimitBytes: 65_536,
          }),
        )
      }),
    )

    await Logs.run([...runArguments(), 'exe_1', '--json'], { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    const printed = JSON.parse(output(stdoutSpy))
    const stdout = printed.data.result.stdout
    expect(decodeStream(stdout)).toBe('[REDACTED]')
    expect(stdout.retainedBytes).toBe(Buffer.byteLength('[REDACTED]', 'utf8'))
    expect(stdout.totalBytes).toBe(200_000)
    expect(stdout.truncated).toBe(true)
    const stderr = printed.data.result.stderr
    expect(stderr.retainedBytes).toBe(0)
    expect(stderr.totalBytes).toBe(200_000)
    expect(stderr.truncated).toBe(true)
  })
})

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newRequestId } from '../../src/auth/errors.js'
import { CliOAuthClient } from '../../src/auth/oauth-client.js'
import { DEFAULT_PROJECT_CONFIG } from '../../src/cli/runtime.js'
import AuthLogout from '../../src/commands/auth/logout.js'
import Sizes from '../../src/commands/sizes.js'
import { ProjectIdSchema, SessionIdSchema } from '../../src/domain/ids.js'
import { OcboxError } from '../../src/errors/index.js'
import type { CasFastTransport, CasTransport } from '../../src/sync/cas-contract.js'
import { runCasPush } from '../../src/sync/cas-push.js'
import type { SyncContext } from '../../src/sync/service.js'
import {
  API_META_TIMEOUT_MILLISECONDS,
  apiUrlFromArgv,
  assertCliVersionSupported,
  checkCliVersionGate,
  isCliOutdatedError,
  outdatedVersionMessage,
  resetVersionGate,
} from '../../src/version/gate.js'
import { isInformationalInvocation, runStartupVersionGate } from '../../src/version/startup.js'
import {
  compareVersions,
  isVersionOlder,
  normalizeVersion,
  parseVersion,
} from '../../src/version/version.js'

const originalExitCode = process.exitCode
const originalEnvironment = { ...process.env }
const roots: string[] = []
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

beforeEach(async () => {
  process.exitCode = 0
  resetVersionGate()
  const root = await mkdtemp(join(tmpdir(), 'ocbox-gate-'))
  roots.push(root)
  // Keep credential/logout tests away from the developer's real store and from
  // any other test file that shares this worker's environment.
  process.env['HOME'] = join(root, 'home')
  process.env['XDG_CONFIG_HOME'] = join(root, 'config')
  process.env['XDG_STATE_HOME'] = join(root, 'state-home')
  process.env['APPDATA'] = join(root, 'appdata')
  process.env['LOCALAPPDATA'] = join(root, 'localappdata')
  process.env['USERPROFILE'] = join(root, 'userprofile')
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
})

afterEach(async () => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetVersionGate()
  process.exitCode = originalExitCode
  for (const name of Object.keys(process.env)) {
    if (!(name in originalEnvironment)) delete process.env[name]
  }
  Object.assign(process.env, originalEnvironment)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('version comparison', () => {
  it('compares only the numeric release core', () => {
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0)
    expect(isVersionOlder('0.9.9', '1.0.0')).toBe(true)
    expect(parseVersion('not-a-version')).toBeUndefined()
  })

  it('strips only the lowercase v, exactly like the install scripts', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3')
    expect(normalizeVersion('V1.2.3')).toBe('V1.2.3')
  })
})

describe('API minimum version gate', () => {
  it('reports an outdated CLI with the exact update command', async () => {
    const result = await checkCliVersionGate({
      apiUrl: 'https://api.example.test',
      currentVersion: '0.1.0',
      fetch: vi.fn(async () => jsonResponse({ minCliVersion: '0.2.0' })),
    })

    expect(result.status).toBe('outdated')
    expect(result.minimumVersion).toBe('0.2.0')
    expect(result.message).toBe(
      'ocbox 0.1.0 is older than the minimum supported version 0.2.0; run: ocbox update',
    )
    expect(result.message).toBe(outdatedVersionMessage('0.1.0', '0.2.0'))
  })

  it('accepts a current CLI and a missing meta answer', async () => {
    const current = await checkCliVersionGate({
      apiUrl: 'https://api.example.test',
      currentVersion: '0.2.0',
      fetch: vi.fn(async () => jsonResponse({ minCliVersion: '0.2.0' })),
    })
    expect(current.status).toBe('current')

    resetVersionGate()
    const missing = await checkCliVersionGate({
      apiUrl: 'https://api.example.test',
      currentVersion: '0.1.0',
      fetch: vi.fn(async () => jsonResponse({ error: 'not found' }, 404)),
    })
    expect(missing.status).toBe('unknown')
  })

  it('gates a self-hosted loopback API instead of exempting it', async () => {
    const fetch = vi.fn(async () => jsonResponse({ minCliVersion: '9.0.0' }))
    const result = await checkCliVersionGate({
      apiUrl: 'http://127.0.0.1:4567',
      currentVersion: '0.1.0',
      fetch,
    })

    expect(result.status).toBe('outdated')
    expect(result.minimumVersion).toBe('9.0.0')
    expect(result.message).toContain('run: ocbox update')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refuses an API request after the gate is outdated but lets a local command finish', async () => {
    await checkCliVersionGate({
      apiUrl: 'https://api.example.test',
      currentVersion: '0.1.0',
      fetch: vi.fn(async () => jsonResponse({ minCliVersion: '0.2.0' })),
    })

    const root = await mkdtemp(join(tmpdir(), 'ocbox-gate-'))
    roots.push(root)
    const config = join(root, 'opencloudbox.toml')
    await writeFile(config, DEFAULT_PROJECT_CONFIG.replace('name = "fake"', 'name = "ocbox"'))
    const runtimeFlags = ['--config', config, '--state-dir', join(root, 'state')]

    await Sizes.run([...runtimeFlags, '--api-url', 'https://api.example.test'], {
      root: process.cwd(),
    })
    expect(process.exitCode).toBe(1)
    expect(output(stderrSpy)).toContain('Update ocbox before using the hosted API')
    expect(output(stderrSpy)).toContain('run: ocbox update')

    process.exitCode = 0
    stderrSpy.mockClear()
    await AuthLogout.run(runtimeFlags, { root: process.cwd() })
    expect(process.exitCode ?? 0).toBe(0)
    expect(output(stderrSpy)).toBe('')
    expect(() => assertCliVersionSupported()).toThrow(/run: ocbox update/)
  })

  it('refuses the token exchange for an outdated CLI before it sends the request', async () => {
    await checkCliVersionGate({
      apiUrl: 'https://api.example.test',
      currentVersion: '0.1.0',
      fetch: vi.fn(async () => jsonResponse({ minCliVersion: '0.2.0' })),
    })
    const fetch = vi.fn()
    const client = new CliOAuthClient({
      apiBase: 'https://api.example.test',
      tokenEndpoint: 'https://api.example.test/v1/auth/cli/token',
      revocationEndpoint: 'https://api.example.test/v1/auth/cli/revoke',
      clientId: 'ocb_cli',
      fetch,
      timeoutMilliseconds: 1_000,
    })

    await expect(
      client.exchangeAuthorizationCode({
        code: 'code',
        redirectUri: 'http://127.0.0.1/callback',
        codeVerifier: 'v'.repeat(43),
      }),
    ).rejects.toThrow(/run: ocbox update/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('prints the notice once at startup and skips informational invocations', async () => {
    const fetch = vi.fn(async () => jsonResponse({ minCliVersion: '0.2.0' }))
    vi.stubGlobal('fetch', fetch)
    process.env['OCBOX_API_URL'] = 'https://api.example.test'

    await runStartupVersionGate(['status'])
    expect(output(stderrSpy)).toBe(
      'ocbox 0.1.0 is older than the minimum supported version 0.2.0; run: ocbox update\n',
    )

    stderrSpy.mockClear()
    await runStartupVersionGate(['--help'])
    expect(output(stderrSpy)).toBe('')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('prints the startup notice once and a distinct error for the refused command', async () => {
    const fetch = vi.fn(async () => jsonResponse({ minCliVersion: '0.2.0' }))
    vi.stubGlobal('fetch', fetch)
    process.env['OCBOX_API_URL'] = 'https://api.example.test'

    await runStartupVersionGate(['sizes'])
    const root = await mkdtemp(join(tmpdir(), 'ocbox-gate-'))
    roots.push(root)
    const config = join(root, 'opencloudbox.toml')
    await writeFile(config, DEFAULT_PROJECT_CONFIG.replace('name = "fake"', 'name = "ocbox"'))
    await Sizes.run(
      [
        '--config',
        config,
        '--state-dir',
        join(root, 'state'),
        '--api-url',
        'https://api.example.test',
      ],
      { root: process.cwd() },
    )

    const text = output(stderrSpy)
    const notice = outdatedVersionMessage('0.1.0', '0.2.0')
    expect(text.split(notice)).toHaveLength(2)
    expect(text).toContain('Update ocbox before using the hosted API')
    expect(process.exitCode).toBe(1)
  })

  it('lets an offline harness opt out of the startup gate', async () => {
    const fetch = vi.fn(async () => jsonResponse({ minCliVersion: '0.2.0' }))
    vi.stubGlobal('fetch', fetch)
    process.env['OCBOX_API_URL'] = 'https://api.example.test'
    process.env['OCBOX_DISABLE_VERSION_GATE'] = '1'

    await runStartupVersionGate(['status'])

    expect(fetch).not.toHaveBeenCalled()
    expect(output(stderrSpy)).toBe('')
  })

  it('bounds the meta request so a hanging API cannot stall a local command', () => {
    expect(API_META_TIMEOUT_MILLISECONDS).toBeLessThanOrEqual(750)
  })

  it('ignores help and version flags after the -- separator', () => {
    expect(isInformationalInvocation(['exec', '--', 'some-command', '--version'])).toBe(false)
    expect(isInformationalInvocation(['exec', '--', 'some-command', '--help'])).toBe(false)
    expect(isInformationalInvocation(['exec', '--help'])).toBe(true)
  })

  it('propagates a gate refusal instead of treating it as a missing server capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocbox-gate-sync-'))
    roots.push(root)
    const localRoot = join(root, 'local')
    await mkdir(localRoot)
    await writeFile(join(localRoot, 'file.txt'), 'hello')
    const gateError = new OcboxError({
      code: 'CAPABILITY_UNSUPPORTED',
      message: 'Update ocbox before using the hosted API; run: ocbox update',
      details: { reasonCode: 'cli_outdated' },
      requestId: newRequestId(),
    })
    expect(isCliOutdatedError(gateError)).toBe(true)
    const call = vi.fn(async () => {
      throw new Error('the v2 path must not run')
    })
    const check = vi.fn(async () => {
      throw gateError
    })
    const fastApply = vi.fn()
    const transport: CasTransport & Partial<CasFastTransport> = {
      sessionId: 'session',
      scope: 'scope',
      call,
      check,
      fastApply,
    }
    const context: SyncContext = {
      providerName: 'fake',
      projectId: ProjectIdSchema.parse('11111111-1111-4111-8111-111111111111'),
      sessionId: SessionIdSchema.parse('22222222-2222-4222-8222-222222222222'),
      stateDirectory: join(root, 'state'),
      localRoot,
      remoteRoot: join(root, 'remote'),
      casTransport: transport,
    }

    await expect(
      runCasPush(context, {
        cliRules: [],
        delete: false,
        yes: false,
        interactive: false,
        confirm: async () => false,
        pause: async () => {},
      }),
    ).rejects.toBe(gateError)
    expect(call).not.toHaveBeenCalled()
    expect(fastApply).not.toHaveBeenCalled()
  })

  it('reads --api-url from the raw command line before oclif parses it', () => {
    expect(apiUrlFromArgv(['status', '--api-url', 'https://api.example.test'], {})).toBe(
      'https://api.example.test',
    )
    expect(apiUrlFromArgv(['status', '--api-url=https://api.example.test'], {})).toBe(
      'https://api.example.test',
    )
    expect(apiUrlFromArgv(['status'], { OCBOX_API_URL: 'https://env.example.test' })).toBe(
      'https://env.example.test',
    )
  })
})

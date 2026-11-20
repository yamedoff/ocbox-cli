import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliOAuthClient } from '../../src/auth/oauth-client.js'
import { DEFAULT_PROJECT_CONFIG } from '../../src/cli/runtime.js'
import AuthLogout from '../../src/commands/auth/logout.js'
import Sizes from '../../src/commands/sizes.js'
import {
  apiUrlFromArgv,
  assertCliVersionSupported,
  checkCliVersionGate,
  outdatedVersionMessage,
  resetVersionGate,
} from '../../src/version/gate.js'
import { runStartupVersionGate } from '../../src/version/startup.js'
import { compareVersions, isVersionOlder, parseVersion } from '../../src/version/version.js'

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

beforeEach(() => {
  process.exitCode = 0
  resetVersionGate()
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

  it('does not ask a loopback test API for a compatibility contract', async () => {
    const fetch = vi.fn(async () => jsonResponse({ minCliVersion: '9.0.0' }))
    const result = await checkCliVersionGate({
      apiUrl: 'http://127.0.0.1:4567',
      currentVersion: '0.1.0',
      fetch,
    })

    expect(result.status).toBe('skipped')
    expect(fetch).not.toHaveBeenCalled()
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
    expect(output(stderrSpy)).toContain(
      'ocbox 0.1.0 is older than the minimum supported version 0.2.0; run: ocbox update',
    )

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

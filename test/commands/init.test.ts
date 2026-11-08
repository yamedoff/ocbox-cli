import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthMetadataStore } from '../../src/auth/metadata.js'
import {
  createCredentialStore,
  defaultCredentialKey,
  resolveAuthEndpoints,
} from '../../src/auth/runtime.js'
import Init from '../../src/commands/init.js'
import { DEFAULT_PROJECT_CONFIG } from '../../src/cli/runtime.js'
import { UtcTimestampSchema } from '../../src/domain/timestamps.js'
import { DEFAULT_API_URL } from '../../src/providers/ocbox/defaults.js'

const NOT_LOGGED_IN_MESSAGE =
  'Not logged in. Run `ocbox auth login`, or pass --provider fake to use the local test harness (nothing runs remotely).'
const FAKE_PROVIDER_NOTICE = 'Using the local fake provider; nothing runs remotely.'

const originalExitCode = process.exitCode
const originalEnvironment = { ...process.env }
const roots: string[] = []
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

function output(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join('')
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ocbox-init-command-'))
  roots.push(root)
  // No login metadata or credential can leak in from the developer's home.
  process.env['HOME'] = join(root, 'home')
  process.env['XDG_CONFIG_HOME'] = join(root, 'config')
  process.env['XDG_STATE_HOME'] = join(root, 'state-home')
  process.env['APPDATA'] = join(root, 'appdata')
  process.env['LOCALAPPDATA'] = join(root, 'localappdata')
  process.env['USERPROFILE'] = join(root, 'userprofile')
  return root
}

async function logIn(root: string): Promise<string> {
  const state = join(root, 'state')
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
  return state
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' },
  })
}

beforeEach(() => {
  process.exitCode = 0
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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('init command', () => {
  it('fails closed without a login when --provider is omitted', async () => {
    const root = await temporaryRoot()
    const config = join(root, 'opencloudbox.toml')

    await Init.run(['--config', config, '--state-dir', join(root, 'state')], {
      root: process.cwd(),
    })

    expect(process.exitCode).toBe(1)
    expect(output(stderrSpy)).toBe(`${NOT_LOGGED_IN_MESSAGE}\n`)
    await expect(readFile(config, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts an explicit fake provider and prints the notice once', async () => {
    const root = await temporaryRoot()
    const config = join(root, 'opencloudbox.toml')

    await Init.run(['--provider', 'fake', '--config', config, '--state-dir', join(root, 'state')], {
      root: process.cwd(),
    })

    expect(process.exitCode ?? 0).toBe(0)
    expect(output(stdoutSpy)).toBe('Project configuration created\n')
    expect(output(stderrSpy)).toBe(`${FAKE_PROVIDER_NOTICE}\n`)
    expect(await readFile(config, 'utf8')).toContain('name = "fake"')
  })

  it('names the created hosted project and the config it wrote', async () => {
    const root = await temporaryRoot()
    const config = join(root, 'opencloudbox.toml')
    const state = await logIn(root)
    const timestamp = new Date().toISOString()
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input))
        calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
        if (url.pathname === '/v1/projects' && init?.method === 'POST') {
          return jsonResponse(
            { id: 'prj_cold_demo', name: 'cold-demo', createdAt: timestamp, updatedAt: timestamp },
            201,
          )
        }
        return jsonResponse({ data: [], nextCursor: null })
      }),
    )

    await Init.run(['--config', config, '--state-dir', state, '--api-url', DEFAULT_API_URL], {
      root: process.cwd(),
    })

    expect(process.exitCode ?? 0).toBe(0)
    expect(output(stdoutSpy)).toBe(
      'Created project prj_cold_demo ("cold-demo") and wrote opencloudbox.toml\n',
    )
    expect(calls).toEqual(['GET /v1/projects', 'POST /v1/projects'])
    expect(await readFile(config, 'utf8')).toContain('projectId = "prj_cold_demo"')
  })

  it('names the existing hosted project it reused for a new config', async () => {
    const root = await temporaryRoot()
    const config = join(root, 'opencloudbox.toml')
    const state = await logIn(root)
    const timestamp = new Date().toISOString()
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input))
        calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
        return jsonResponse({
          data: [
            {
              id: 'prj_reused',
              name: basename(process.cwd()),
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          nextCursor: null,
        })
      }),
    )

    await Init.run(['--config', config, '--state-dir', state, '--api-url', DEFAULT_API_URL], {
      root: process.cwd(),
    })

    expect(process.exitCode ?? 0).toBe(0)
    expect(output(stdoutSpy)).toBe(
      `Using existing project prj_reused ("${basename(process.cwd())}"), matched by name; run ocbox project create to make a new one\n`,
    )
    expect(calls).toEqual(['GET /v1/projects'])
  })

  it('says it validated an existing config instead of reporting a new project', async () => {
    const root = await temporaryRoot()
    const config = join(root, 'opencloudbox.toml')
    const state = await logIn(root)
    await writeFile(
      config,
      DEFAULT_PROJECT_CONFIG.replace('name = "fake"', 'name = "ocbox"').replace(
        'schemaVersion = 1',
        'schemaVersion = 1\nprojectId = "prj_existing"',
      ),
    )
    const fetch = vi.fn(async () => {
      throw new Error('existing config must not call the API')
    })
    vi.stubGlobal('fetch', fetch)

    await Init.run(['--config', config, '--state-dir', state, '--api-url', DEFAULT_API_URL], {
      root: process.cwd(),
    })

    expect(process.exitCode ?? 0).toBe(0)
    expect(output(stdoutSpy)).toBe('Validated opencloudbox.toml\n')
    expect(fetch).not.toHaveBeenCalled()
  })
})

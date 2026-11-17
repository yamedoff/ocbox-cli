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
import Sizes from '../../src/commands/sizes.js'
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

const GIB = 1024 ** 3
const runArguments = () => ['--config', config, '--state-dir', state, '--api-url', DEFAULT_API_URL]

beforeEach(async () => {
  process.exitCode = 0
  root = await mkdtemp(join(tmpdir(), 'ocbox-sizes-'))
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

describe('sizes command', () => {
  it('lists the sizes the plan allows, in the order the API gives them', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        calls.push(new URL(String(input)).pathname)
        return jsonResponse({
          data: [
            {
              id: 'cpu-small',
              gpuType: null,
              gpuCount: 0,
              cpuMillicores: 2000,
              memoryBytes: 4 * GIB,
              diskBytes: 20 * GIB,
              maxLifetimeSeconds: 7200,
              price: { microUsdPerHour: 0 },
            },
            {
              id: 'gpu-small',
              gpuType: 'gpu-a',
              gpuCount: 1,
              cpuMillicores: 8000,
              memoryBytes: 64 * GIB,
              diskBytes: 100 * GIB,
              maxLifetimeSeconds: 3600,
              price: { microUsdPerHour: 1_500_000 },
            },
          ],
        })
      }),
    )

    await Sizes.run(runArguments(), { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    expect(calls).toEqual(['/v1/sizes'])
    expect(output(stdoutSpy)).toBe(
      [
        'cpu-small  no GPU, 2 CPU, 4 GiB memory, 20 GiB disk, max 2h, $0.00/h',
        'gpu-small  1 x gpu-a, 8 CPU, 64 GiB memory, 100 GiB disk, max 1h, $1.50/h',
        '',
      ].join('\n'),
    )
  })

  it('tolerates fields it does not know and fields the API has not sent yet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ data: [{ id: 'gpu-small', maxLifetimeSeconds: 3600, newField: 'later' }] }),
      ),
    )

    await Sizes.run([...runArguments(), '--json'], { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    const printed = JSON.parse(output(stdoutSpy))
    expect(printed.data.sizes).toEqual([{ id: 'gpu-small', maxLifetimeSeconds: 3600 }])
  })

  it('says so when the plan has no sizes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: [] })),
    )

    await Sizes.run(runArguments(), { root: process.cwd() })

    expect(output(stdoutSpy)).toBe('No sizes on your plan\n')
  })
})

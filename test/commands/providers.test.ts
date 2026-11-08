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
import Providers from '../../src/commands/providers.js'
import { DEFAULT_PROJECT_CONFIG } from '../../src/cli/runtime.js'
import { UtcTimestampSchema } from '../../src/domain/timestamps.js'
import { DEFAULT_API_URL } from '../../src/providers/ocbox/defaults.js'

const originalExitCode = process.exitCode
const originalEnvironment = { ...process.env }
const roots: string[] = []
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

function output(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join('')
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ocbox-providers-command-'))
  roots.push(root)
  process.env['HOME'] = join(root, 'home')
  process.env['XDG_CONFIG_HOME'] = join(root, 'config')
  process.env['XDG_STATE_HOME'] = join(root, 'state-home')
  process.env['APPDATA'] = join(root, 'appdata')
  process.env['LOCALAPPDATA'] = join(root, 'localappdata')
  process.env['USERPROFILE'] = join(root, 'userprofile')
  return root
}

async function logIn(state: string): Promise<void> {
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

beforeEach(() => {
  process.exitCode = 0
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
})

afterEach(async () => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  vi.restoreAllMocks()
  process.exitCode = originalExitCode
  for (const name of Object.keys(process.env)) {
    if (!(name in originalEnvironment)) delete process.env[name]
  }
  Object.assign(process.env, originalEnvironment)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('providers command login state', () => {
  it('reports the hosted provider as available and authenticated when a valid login exists', async () => {
    const root = await temporaryRoot()
    const config = join(root, 'opencloudbox.toml')
    const state = join(root, 'state')
    await writeFile(
      config,
      DEFAULT_PROJECT_CONFIG.replace('name = "fake"', 'name = "ocbox"').replace(
        'schemaVersion = 1',
        'schemaVersion = 1\nprojectId = "prj_demo"',
      ),
    )
    await logIn(state)

    await Providers.run(['--config', config, '--state-dir', state], {
      root: process.cwd(),
    })

    expect(process.exitCode ?? 0).toBe(0)
    expect(output(stdoutSpy)).toBe(
      'fake available=true auth=not_required\nocbox available=true auth=ok\n',
    )
  })
})

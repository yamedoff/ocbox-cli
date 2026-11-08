import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SCOPES } from '../../src/auth/config.js'
import { AuthMetadataStore } from '../../src/auth/metadata.js'
import { createCredentialStore, defaultCredentialKey } from '../../src/auth/runtime.js'
import AuthStatus from '../../src/commands/auth/status.js'
import { UtcTimestampSchema } from '../../src/domain/timestamps.js'

const originalExitCode = process.exitCode
const originalEnvironment = { ...process.env }
const roots: string[] = []
const servers: Array<() => Promise<void>> = []
let root: string
let stdoutSpy: ReturnType<typeof vi.spyOn>

function output(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join('')
}

async function serve(handler: (response: ServerResponse) => void): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url === '/v1/auth/me') return handler(response)
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  servers.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  )
  return origin
}

beforeEach(async () => {
  process.exitCode = 0
  root = await mkdtemp(join(tmpdir(), 'ocbox-auth-status-identity-'))
  roots.push(root)
  process.env['HOME'] = join(root, 'home')
  process.env['XDG_CONFIG_HOME'] = join(root, 'config')
  process.env['XDG_STATE_HOME'] = join(root, 'state-home')
  process.env['APPDATA'] = join(root, 'appdata')
  process.env['LOCALAPPDATA'] = join(root, 'localappdata')
  process.env['USERPROFILE'] = join(root, 'userprofile')
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
})

afterEach(async () => {
  vi.restoreAllMocks()
  process.exitCode = originalExitCode
  for (const name of Object.keys(process.env)) {
    if (!(name in originalEnvironment)) delete process.env[name]
  }
  Object.assign(process.env, originalEnvironment)
  await Promise.all(servers.splice(0).map((close) => close()))
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('auth status identity', () => {
  it('prints the real expiresAt from /auth/me instead of unknown', async () => {
    const origin = await serve((response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          subject: 'user-a',
          audience: 'cli',
          scopes: [...DEFAULT_SCOPES],
          expiresAt: '2026-11-08T12:00:00.000Z',
        }),
      )
    })
    const stateDirectory = join(root, 'state')
    const key = defaultCredentialKey()
    await createCredentialStore().set(key, {
      accessToken: 'fixture-access-'.padEnd(48, 'a'),
      expiresAt: null,
      scopes: [...DEFAULT_SCOPES],
      tokenType: 'Bearer',
    })
    await new AuthMetadataStore(join(stateDirectory, 'auth.json')).save({
      schemaVersion: 1,
      issuer: origin,
      clientId: 'ocb_cli',
      audience: 'cli',
      scopes: [...DEFAULT_SCOPES],
      expiresAt: null,
      identity: key,
      updatedAt: UtcTimestampSchema.parse(new Date().toISOString()),
    })
    await AuthStatus.run(['--state-dir', stateDirectory, '--api-url', origin], {
      root: process.cwd(),
    })
    const text = output(stdoutSpy)
    expect(text).toContain('expires=2026-11-08T12:00:00.000Z')
    expect(text).not.toContain('expires=unknown')
  })
})

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
import ProjectDelete from '../../src/commands/project/delete.js'
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

beforeEach(async () => {
  process.exitCode = 0
  root = await mkdtemp(join(tmpdir(), 'ocbox-project-delete-'))
  roots.push(root)
  process.env['HOME'] = join(root, 'home')
  process.env['XDG_CONFIG_HOME'] = join(root, 'config')
  process.env['XDG_STATE_HOME'] = join(root, 'state-home')
  process.env['APPDATA'] = join(root, 'appdata')
  process.env['LOCALAPPDATA'] = join(root, 'localappdata')
  process.env['USERPROFILE'] = join(root, 'userprofile')
  state = join(root, 'state')
  config = join(root, 'opencloudbox.toml')
  await writeFile(
    config,
    DEFAULT_PROJECT_CONFIG.replace('name = "fake"', 'name = "ocbox"').replace(
      'schemaVersion = 1',
      'schemaVersion = 1\nprojectId = "prj_current"',
    ),
  )
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

describe('project delete command', () => {
  it('calls the hosted DELETE route and reports the operation', async () => {
    const timestamp = new Date().toISOString()
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
        return jsonResponse(
          {
            id: 'op_delete',
            createdAt: timestamp,
            updatedAt: timestamp,
            kind: 'project_delete',
            projectId: 'prj_current',
            sessionId: null,
            state: 'pending',
            progress: 0,
            requestId: 'request-1',
            error: null,
            resource: null,
          },
          202,
        )
      }),
    )

    await ProjectDelete.run(
      ['--config', config, '--state-dir', state, '--api-url', DEFAULT_API_URL, '--yes'],
      { root: process.cwd() },
    )

    expect(process.exitCode ?? 0).toBe(0)
    expect(output(stdoutSpy)).toBe('Project deletion accepted (operation op_delete)\n')
    expect(calls).toEqual([
      { method: 'DELETE', path: '/v1/projects/prj_current', key: expect.any(String) },
    ])
  })

  it('passes the API refusal message and next step through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 'OPERATION_CONFLICT',
              message: 'Project still has a running box',
              nextStep: 'Run ocbox stop and ocbox destroy before deleting the project',
            },
            requestId: 'request-1',
          },
          409,
        ),
      ),
    )

    await ProjectDelete.run(
      ['--config', config, '--state-dir', state, '--api-url', DEFAULT_API_URL, '--yes'],
      { root: process.cwd() },
    )

    expect(process.exitCode).toBe(1)
    expect(output(stderrSpy)).toBe(
      'Project still has a running box\nNext: Run ocbox stop and ocbox destroy before deleting the project\n',
    )
  })
})

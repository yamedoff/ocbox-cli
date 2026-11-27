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
import SessionList from '../../src/commands/session/list.js'
import { PowerShellWindowsAclProtector } from '../../src/credentials/windows-acl.js'
import { UtcTimestampSchema } from '../../src/domain/timestamps.js'
import { DEFAULT_API_URL } from '../../src/providers/ocbox/defaults.js'

const originalExitCode = process.exitCode
const originalEnvironment = { ...process.env }
const roots: string[] = []
let root: string
let state: string
let config: string
let stdoutSpy: ReturnType<typeof vi.spyOn> | undefined
let stderrSpy: ReturnType<typeof vi.spyOn> | undefined

function output(spy: ReturnType<typeof vi.spyOn> | undefined): string {
  if (spy === undefined) throw new Error('The output spy is not installed')
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
  // The credential store verifies Windows ACLs by starting powershell.exe. On
  // the Windows CI runner a cold start can outlast the 10s hook budget, so this
  // suite answers the ACL boundary in-process: it covers command routing, not
  // ACL protection (test/infrastructure/credentials.test.ts does).
  vi.spyOn(PowerShellWindowsAclProtector.prototype, 'protectAndVerify').mockResolvedValue(true)
  process.exitCode = 0
  root = await mkdtemp(join(tmpdir(), 'ocbox-session-list-'))
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
  // A timed-out beforeEach never installed the spies; teardown must not throw
  // and mask the hook's own error.
  stdoutSpy?.mockRestore()
  stderrSpy?.mockRestore()
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

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ses_1',
    createdAt: now(),
    updatedAt: now(),
    projectId: 'prj_1',
    requestedSpec: { cpu: 2, memoryMib: 2048 },
    effectiveSpec: { cpu: 2, memoryMib: 2048 },
    normalizedState: 'running',
    rawState: 'RUNNING',
    sandboxes: [],
    primarySandboxId: null,
    ...overrides,
  }
}

describe('session list command', () => {
  it('lists owner-wide Sessions without --project-id', async () => {
    const calls: { path: string; query: Record<string, string> }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = new URL(String(input))
        calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) })
        return jsonResponse({
          data: [
            session({ id: 'ses_owner_1', projectId: 'prj_1' }),
            session({ id: 'ses_owner_2', projectId: 'prj_2', normalizedState: 'paused' }),
          ],
          nextCursor: 'next-owner',
        })
      }),
    )

    await SessionList.run([...runArguments(), '--limit', '10', '--include-destroyed', '--json'], {
      root: process.cwd(),
    })

    expect(process.exitCode ?? 0).toBe(0)
    expect(calls).toEqual([
      { path: '/v1/sessions', query: { includeDestroyed: 'true', limit: '10' } },
    ])
    const printed = JSON.parse(output(stdoutSpy))
    expect(printed.data.sessions.map((row: { id: string }) => row.id)).toEqual([
      'ses_owner_1',
      'ses_owner_2',
    ])
    expect(printed.data.nextCursor).toBe('next-owner')
  })

  it('keeps listing a project through /v1/projects/:id/sessions', async () => {
    const calls: { path: string; query: Record<string, string> }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = new URL(String(input))
        calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) })
        return jsonResponse({
          data: [session(), session({ id: 'ses_2', normalizedState: 'paused' })],
          nextCursor: null,
        })
      }),
    )

    await SessionList.run([...runArguments(), '--project-id', 'prj_1'], { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    expect(calls).toEqual([{ path: '/v1/projects/prj_1/sessions', query: {} }])
    expect(output(stdoutSpy)).toContain('ses_1  running  project=prj_1')
    expect(output(stdoutSpy)).toContain('ses_2  paused  project=prj_1')
  })

  it('does not put --project-id in the owner-wide More hint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          data: [session()],
          nextCursor: 'next-owner',
        }),
      ),
    )

    await SessionList.run([...runArguments(), '--limit', '10', '--include-destroyed'], {
      root: process.cwd(),
    })

    expect(process.exitCode ?? 0).toBe(0)
    const printed = output(stdoutSpy)
    expect(printed).toContain('More: ocbox session list')
    expect(printed).not.toContain('--project-id')
    expect(printed).toContain('--cursor next-owner')
  })

  it('keeps --project-id in the project More hint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          data: [session()],
          nextCursor: 'next-project',
        }),
      ),
    )

    await SessionList.run([...runArguments(), '--project-id', 'prj_1'], { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    const printed = output(stdoutSpy)
    expect(printed).toContain('--project-id prj_1')
    expect(printed).toContain('--cursor next-project')
  })
})

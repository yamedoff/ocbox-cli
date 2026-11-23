import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthMetadataStore } from '../../src/auth/metadata.js'
import {
  createCredentialStore,
  defaultCredentialKey,
  resolveAuthEndpoints,
} from '../../src/auth/runtime.js'
import { DEFAULT_PROJECT_CONFIG, resolveAccountStateDirectory } from '../../src/cli/runtime.js'
import SnapshotDelete from '../../src/commands/snapshot/delete.js'
import SnapshotList from '../../src/commands/snapshot/list.js'
import SnapshotRestore from '../../src/commands/snapshot/restore.js'
import SnapshotSave from '../../src/commands/snapshot/save.js'
import type { Session } from '../../src/contracts.js'
import { PowerShellWindowsAclProtector } from '../../src/credentials/windows-acl.js'
import { UtcTimestampSchema } from '../../src/domain/timestamps.js'
import { LifecycleStore, projectIdForPath } from '../../src/lifecycle/index.js'
import { DEFAULT_API_URL } from '../../src/providers/ocbox/defaults.js'

const originalExitCode = process.exitCode
const originalEnvironment = { ...process.env }
const roots: string[] = []
let root: string
let state: string
let config: string
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

const SESSION_ID = '11111111-1111-4111-8111-111111111111' as Session['id']
const OTHER_SESSION_ID = '22222222-2222-4222-8222-222222222222' as Session['id']
const PROJECT_ID = '33333333-3333-4333-8333-333333333333'

function output(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join('')
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' },
  })
}

function operation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const timestamp = new Date().toISOString()
  return {
    id: 'op_snapshot',
    createdAt: timestamp,
    updatedAt: timestamp,
    kind: 'session.snapshot',
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    state: 'pending',
    progress: 0,
    requestId: 'request-1',
    error: null,
    resource: { type: 'session', id: SESSION_ID },
    ...overrides,
  }
}

function errorEnvelope(
  message: string,
  reasonCode: string,
  nextStep: string,
  code = 'SESSION_STATE_CONFLICT',
): Record<string, unknown> {
  return {
    error: {
      code,
      message,
      nextStep,
      reasonCode,
      retryable: false,
    },
    requestId: 'request-1',
  }
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
    subject: 'fixture-subject',
    updatedAt: UtcTimestampSchema.parse(new Date().toISOString()),
  })
}

function session(id: Session['id']): Session {
  const timestamp = UtcTimestampSchema.parse(new Date().toISOString())
  return {
    id,
    projectId: PROJECT_ID as Session['projectId'],
    state: 'error',
    bindings: [],
    currentOperationId: null,
    providerVerifiedAt: null,
    sandboxDeletionVerifiedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

async function seedSessions(activeSessionId: Session['id'] = SESSION_ID): Promise<void> {
  const accountState = await resolveAccountStateDirectory(
    { config, 'state-dir': state },
    state,
    true,
  )
  const store = new LifecycleStore(accountState, projectIdForPath(resolve(process.cwd())))
  await store.update((current) => ({
    ...current,
    activeSessionId,
    sessions: {
      ...current.sessions,
      [SESSION_ID]: session(SESSION_ID),
      [OTHER_SESSION_ID]: session(OTHER_SESSION_ID),
    },
  }))
}

const runArguments = () => ['--config', config, '--state-dir', state, '--api-url', DEFAULT_API_URL]

beforeEach(async () => {
  vi.spyOn(PowerShellWindowsAclProtector.prototype, 'protectAndVerify').mockResolvedValue(true)
  process.exitCode = 0
  root = await mkdtemp(join(tmpdir(), 'ocbox-snapshot-'))
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
      `schemaVersion = 1\nprojectId = "${PROJECT_ID}"`,
    ),
  )
  await logIn()
  await seedSessions()
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
})

afterEach(async () => {
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

interface Call {
  readonly method: string
  readonly path: string
  readonly key: string | null
}

describe('snapshot save', () => {
  it('starts snapshot_create and waits for the Operation', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        calls.push({
          method,
          path: url.pathname,
          key: new Headers(init?.headers).get('idempotency-key'),
        })
        if (method === 'POST' && url.pathname.endsWith('/snapshots'))
          return jsonResponse(operation({ id: 'op_save' }), 202)
        if (method === 'GET' && url.pathname === '/v1/operations/op_save')
          return jsonResponse(operation({ id: 'op_save', state: 'succeeded', progress: 100 }))
        return jsonResponse(errorEnvelope('unexpected call', 'api_request_invalid', 'none'), 400)
      }),
    )

    await SnapshotSave.run([...runArguments(), '--idempotency-key', 'test-idempotency-key-123'], {
      root: process.cwd(),
    })

    expect(process.exitCode ?? 0).toBe(0)
    expect(output(stdoutSpy)).toBe('Snapshot saved (operation op_save)\n')
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/v1/sessions/${SESSION_ID}/snapshots`,
        key: 'test-idempotency-key-123',
      },
      { method: 'GET', path: '/v1/operations/op_save', key: null },
    ])
  })

  it('prints the operation id and does not poll with --no-wait', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input))
        calls.push({
          method: init?.method ?? 'GET',
          path: url.pathname,
          key: new Headers(init?.headers).get('idempotency-key'),
        })
        return jsonResponse(operation({ id: 'op_no_wait' }), 202)
      }),
    )

    await SnapshotSave.run([...runArguments(), '--no-wait'], { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    expect(output(stdoutSpy)).toBe('Snapshot creation accepted (operation op_no_wait)\n')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('POST')
  })

  it('prints snapshot_unsupported and the API next step', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          errorEnvelope(
            'This box cannot take snapshots',
            'snapshot_unsupported',
            'Create a new box; snapshots are available on v2 boxes.',
          ),
          409,
        ),
      ),
    )

    await SnapshotSave.run(runArguments(), { root: process.cwd() })

    expect(process.exitCode).toBe(1)
    expect(output(stderrSpy)).toContain('This box cannot take snapshots')
    expect(output(stderrSpy)).toContain('Reason snapshot_unsupported.')
    expect(output(stderrSpy)).toContain(
      'Next: Create a new box; snapshots are available on v2 boxes.',
    )
  })

  it('prints snapshot_limit_reached with the CLI command that frees a slot', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        calls.push({
          method,
          path: url.pathname,
          key: new Headers(init?.headers).get('idempotency-key'),
        })
        if (method === 'POST') return jsonResponse(operation({ id: 'op_limit' }), 202)
        return jsonResponse(
          operation({
            id: 'op_limit',
            state: 'failed',
            progress: 100,
            error: {
              code: 'SESSION_STATE_CONFLICT',
              message:
                'This box keeps the most snapshots it can; delete one with snapshot_delete to free a slot.',
              nextStep: 'Delete a snapshot with snapshot_delete to free a slot, then retry.',
              reasonCode: 'snapshot_limit_reached',
              retryable: false,
            },
          }),
        )
      }),
    )

    await SnapshotSave.run(runArguments(), { root: process.cwd() })

    expect(process.exitCode).toBe(1)
    expect(output(stderrSpy)).toContain('This box keeps the most snapshots it can')
    expect(output(stderrSpy)).toContain('Reason snapshot_limit_reached.')
    expect(output(stderrSpy)).toContain(
      'Next: Delete a snapshot with `ocbox snapshot delete` to free a slot, then retry.',
    )
    expect(calls.map((call) => call.path)).toEqual([
      `/v1/sessions/${SESSION_ID}/snapshots`,
      '/v1/operations/op_limit',
    ])
  })
})

describe('snapshot list', () => {
  it('prints id, created and size newest first, and defaults to the selected box', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input))
        calls.push({
          method: init?.method ?? 'GET',
          path: url.pathname,
          key: new Headers(init?.headers).get('idempotency-key'),
        })
        return jsonResponse({
          snapshots: [
            { id: 'snap_new', createdAt: '2026-11-23T10:00:00.000Z', sizeBytes: 1024 },
            { id: 'snap_old', createdAt: '2026-11-22T10:00:00.000Z' },
          ],
        })
      }),
    )

    await SnapshotList.run(runArguments(), { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    expect(calls).toEqual([
      { method: 'GET', path: `/v1/sessions/${SESSION_ID}/snapshots`, key: null },
    ])
    expect(output(stdoutSpy)).toBe(
      ['snap_new  2026-11-23T10:00:00.000Z  1 KiB', 'snap_old  2026-11-22T10:00:00.000Z', ''].join(
        '\n',
      ),
    )
  })

  it('uses the box argument when one is given', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        calls.push(new URL(String(input)).pathname)
        return jsonResponse({ snapshots: [] })
      }),
    )

    await SnapshotList.run([...runArguments(), OTHER_SESSION_ID], { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    expect(calls).toEqual([`/v1/sessions/${OTHER_SESSION_ID}/snapshots`])
    expect(output(stdoutSpy)).toBe('No snapshots\n')
  })

  it('prints the raw list with --json', async () => {
    const snapshots = [
      { id: 'snap_new', createdAt: '2026-11-23T10:00:00.000Z', sizeBytes: 2048 },
      { id: 'snap_old', createdAt: '2026-11-22T10:00:00.000Z' },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ snapshots })),
    )

    await SnapshotList.run([...runArguments(), '--json'], { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    const printed = JSON.parse(output(stdoutSpy))
    expect(printed.data.snapshots).toEqual(snapshots)
  })

  it('prints snapshot_unsupported and the API next step', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          errorEnvelope(
            'This box cannot take snapshots',
            'snapshot_unsupported',
            'Create a new box; snapshots are available on v2 boxes.',
          ),
          409,
        ),
      ),
    )

    await SnapshotList.run(runArguments(), { root: process.cwd() })

    expect(process.exitCode).toBe(1)
    expect(output(stderrSpy)).toContain('This box cannot take snapshots')
    expect(output(stderrSpy)).toContain('Reason snapshot_unsupported.')
    expect(output(stderrSpy)).toContain(
      'Next: Create a new box; snapshots are available on v2 boxes.',
    )
  })
})

describe('snapshot restore', () => {
  it('starts snapshot_restore and waits for the Operation', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        calls.push({
          method,
          path: url.pathname,
          key: new Headers(init?.headers).get('idempotency-key'),
        })
        if (method === 'POST' && url.pathname.endsWith('/restore'))
          return jsonResponse(operation({ id: 'op_restore' }), 202)
        return jsonResponse(operation({ id: 'op_restore', state: 'succeeded', progress: 100 }))
      }),
    )

    await SnapshotRestore.run(
      [...runArguments(), 'snap_1', '--idempotency-key', 'test-restore-key-123'],
      { root: process.cwd() },
    )

    expect(process.exitCode ?? 0).toBe(0)
    expect(output(stdoutSpy)).toBe('Snapshot snap_1 restored (operation op_restore)\n')
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/v1/sessions/${SESSION_ID}/snapshots/snap_1/restore`,
        key: 'test-restore-key-123',
      },
      { method: 'GET', path: '/v1/operations/op_restore', key: null },
    ])
  })

  it('prints snapshot_not_found and the CLI command that lists snapshots', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        if (init?.method === 'POST') return jsonResponse(operation({ id: 'op_missing' }), 202)
        return jsonResponse(
          operation({
            id: 'op_missing',
            state: 'failed',
            progress: 100,
            error: {
              code: 'NOT_FOUND',
              message: 'Snapshot snap_missing was not found',
              nextStep: 'Call snapshot_list to see the snapshots this box keeps.',
              reasonCode: 'snapshot_not_found',
              retryable: false,
            },
          }),
        )
      }),
    )

    await SnapshotRestore.run([...runArguments(), 'snap_missing'], { root: process.cwd() })

    expect(process.exitCode).toBe(1)
    expect(output(stderrSpy)).toContain('Snapshot snap_missing was not found')
    expect(output(stderrSpy)).toContain('Reason snapshot_not_found.')
    expect(output(stderrSpy)).toContain(
      'Next: Call `ocbox snapshot list` to see the snapshots this box keeps.',
    )
  })
})

describe('snapshot delete', () => {
  it('starts snapshot_delete and waits for the Operation', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        calls.push({
          method,
          path: url.pathname,
          key: new Headers(init?.headers).get('idempotency-key'),
        })
        if (method === 'DELETE') return jsonResponse(operation({ id: 'op_delete' }), 202)
        return jsonResponse(operation({ id: 'op_delete', state: 'succeeded', progress: 100 }))
      }),
    )

    await SnapshotDelete.run(
      [...runArguments(), 'snap_1', '--idempotency-key', 'test-delete-key-123'],
      { root: process.cwd() },
    )

    expect(process.exitCode ?? 0).toBe(0)
    expect(output(stdoutSpy)).toBe('Snapshot snap_1 deleted (operation op_delete)\n')
    expect(calls).toEqual([
      {
        method: 'DELETE',
        path: `/v1/sessions/${SESSION_ID}/snapshots/snap_1`,
        key: 'test-delete-key-123',
      },
      { method: 'GET', path: '/v1/operations/op_delete', key: null },
    ])
  })
})

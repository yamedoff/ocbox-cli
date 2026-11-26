import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { parseProjectConfig, toSandboxSpec } from '../../src/config/index.js'
import SnapshotDelete from '../../src/commands/snapshot/delete.js'
import SnapshotList from '../../src/commands/snapshot/list.js'
import SnapshotRestore from '../../src/commands/snapshot/restore.js'
import SnapshotSave from '../../src/commands/snapshot/save.js'
import {
  OperationContextSchema,
  OperationIdSchema,
  ProjectIdSchema,
  type Sandbox,
  type Session,
  SessionIdSchema,
} from '../../src/contracts.js'
import { PowerShellWindowsAclProtector } from '../../src/credentials/windows-acl.js'
import { UtcTimestampSchema } from '../../src/domain/timestamps.js'
import { LifecycleStore, projectIdForPath } from '../../src/lifecycle/index.js'
import { DEFAULT_API_URL } from '../../src/providers/ocbox/defaults.js'
import { createOcboxProvider } from '../../src/providers/ocbox/factory.js'

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
const HOSTED_SESSION_ID = 'ses_hosted_1'
const OTHER_HOSTED_SESSION_ID = 'ses_hosted_2'
const PROJECT_ID = '33333333-3333-4333-8333-333333333333'
const UNKNOWN_SESSION_ID = '00000000-0000-4000-8000-000000000000'

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
    sessionId: HOSTED_SESSION_ID,
    state: 'pending',
    progress: 0,
    requestId: 'request-1',
    error: null,
    resource: { type: 'session', id: HOSTED_SESSION_ID },
    ...overrides,
  }
}

function notFoundEnvelope(reasonCode: string): Record<string, unknown> {
  return {
    error: {
      code: 'NOT_FOUND',
      message: 'The requested hosted Session was not found',
      nextStep: 'Call session_list to list the Sessions this login owns.',
      reasonCode,
      retryable: false,
    },
    requestId: 'request-1',
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

interface SeedTarget {
  readonly localSessionId: Session['id']
  readonly hostedSessionId: string
  readonly hostedSandboxId: string
  readonly hostedOperationId: string
}

const SEED_TARGETS: readonly SeedTarget[] = [
  {
    localSessionId: SESSION_ID,
    hostedSessionId: HOSTED_SESSION_ID,
    hostedSandboxId: 'sbx_seed_1',
    hostedOperationId: 'op_seed_1',
  },
  {
    localSessionId: OTHER_SESSION_ID,
    hostedSessionId: OTHER_HOSTED_SESSION_ID,
    hostedSandboxId: 'sbx_seed_2',
    hostedOperationId: 'op_seed_2',
  },
]

function seedOperation(target: SeedTarget, state = 'succeeded'): Record<string, unknown> {
  const timestamp = new Date().toISOString()
  return {
    id: target.hostedOperationId,
    createdAt: timestamp,
    updatedAt: timestamp,
    kind: 'session_create',
    projectId: PROJECT_ID,
    sessionId: target.hostedSessionId,
    state,
    progress: 100,
    requestId: 'request-1',
    error: null,
    resource: { type: 'session', id: target.hostedSessionId },
  }
}

function seedHostedSession(target: SeedTarget): Record<string, unknown> {
  const timestamp = new Date().toISOString()
  return {
    createdAt: timestamp,
    effectiveSpec: {},
    id: target.hostedSessionId,
    normalizedState: 'running',
    primarySandboxId: target.hostedSandboxId,
    projectId: PROJECT_ID,
    rawState: 'running',
    requestedSpec: {},
    sandboxes: [
      {
        active: true,
        boundAt: timestamp,
        ordinal: 0,
        releasedAt: null,
        role: 'primary',
        sandboxId: target.hostedSandboxId,
        state: 'running',
      },
    ],
    updatedAt: timestamp,
  }
}

/**
 * Writes the hosted mappings through the real provider, so the test exercises
 * the same login-scoped record `exec` and `sync` read instead of a fixture key.
 */
async function seedHostedMappings(): Promise<void> {
  const accountState = await resolveAccountStateDirectory(
    { config, 'state-dir': state },
    state,
    true,
  )
  const store = new LifecycleStore(accountState, projectIdForPath(resolve(process.cwd())))
  const spec = toSandboxSpec(parseProjectConfig(await readFile(config, 'utf8')))
  let created = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const timestamp = new Date().toISOString()
      if (method === 'GET' && url.pathname === `/v1/projects/${PROJECT_ID}`)
        return jsonResponse({
          id: PROJECT_ID,
          name: 'fixture',
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      if (method === 'POST' && url.pathname === `/v1/projects/${PROJECT_ID}/sessions`) {
        const target = SEED_TARGETS[created]
        created += 1
        if (target === undefined) return jsonResponse({}, 500)
        return jsonResponse(seedOperation(target), 202)
      }
      const operation = SEED_TARGETS.find(
        (target) => url.pathname === `/v1/operations/${target.hostedOperationId}`,
      )
      if (method === 'GET' && operation !== undefined) return jsonResponse(seedOperation(operation))
      const hosted = SEED_TARGETS.find(
        (target) => url.pathname === `/v1/sessions/${target.hostedSessionId}`,
      )
      if (method === 'GET' && hosted !== undefined) return jsonResponse(seedHostedSession(hosted))
      return jsonResponse({}, 404)
    }),
  )
  const sandboxes: Record<Sandbox['id'], Sandbox> = {}
  for (const target of SEED_TARGETS) {
    const provider = createOcboxProvider({ stateDirectory: state, projectId: PROJECT_ID })
    provider.bindLifecycleStore(store)
    const result = await provider.create(
      OperationContextSchema.parse({
        attempt: 1,
        idempotencyKey: `seed-key-${randomUUID()}`,
        issuedAt: new Date().toISOString(),
        operationId: randomUUID(),
        requestId: randomUUID(),
      }),
      {
        adoption: {
          metadata: {
            operationId: OperationIdSchema.parse(randomUUID()),
            sessionId: SessionIdSchema.parse(target.localSessionId),
          },
          strategy: 'serialize_then_reconcile',
        },
        projectId: ProjectIdSchema.parse(PROJECT_ID),
        sessionId: SessionIdSchema.parse(target.localSessionId),
        specification: spec,
      },
    )
    sandboxes[result.sandbox.id] = result.sandbox
  }
  await store.update((current) => ({
    ...current,
    sandboxes: { ...current.sandboxes, ...sandboxes },
  }))
}

async function lifecycleState() {
  const accountState = await resolveAccountStateDirectory(
    { config, 'state-dir': state },
    state,
    true,
  )
  return new LifecycleStore(accountState, projectIdForPath(resolve(process.cwd()))).load()
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
  await seedHostedMappings()
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
        path: `/v1/sessions/${HOSTED_SESSION_ID}/snapshots`,
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
      `/v1/sessions/${HOSTED_SESSION_ID}/snapshots`,
      '/v1/operations/op_limit',
    ])
  })

  it('prints snapshot_limit_reached from a direct refusal with the limit and the CLI command', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? 'GET',
          path: new URL(String(input)).pathname,
          key: new Headers(init?.headers).get('idempotency-key'),
        })
        return jsonResponse(
          {
            error: {
              code: 'SESSION_STATE_CONFLICT',
              message:
                'This box keeps the most snapshots it can; delete one with snapshot_delete to free a slot.',
              nextStep: 'Delete a snapshot with snapshot_delete to free a slot, then retry.',
              reasonCode: 'snapshot_limit_reached',
              retryable: false,
              limitName: 'snapshots',
              limitValue: 5,
            },
            requestId: 'request-1',
          },
          409,
        )
      }),
    )

    await SnapshotSave.run([...runArguments(), '--idempotency-key', 'test-limit-key-123'], {
      root: process.cwd(),
    })

    expect(process.exitCode).toBe(1)
    expect(output(stderrSpy)).toContain('This box keeps the most snapshots it can')
    expect(output(stderrSpy)).toContain('delete one with `ocbox snapshot delete` to free a slot')
    expect(output(stderrSpy)).toContain('The snapshots limit is 5.')
    expect(output(stderrSpy)).toContain(
      'Next: Delete a snapshot with `ocbox snapshot delete` to free a slot, then retry.',
    )
    expect(output(stderrSpy)).toContain('Reason snapshot_limit_reached.')
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/v1/sessions/${HOSTED_SESSION_ID}/snapshots`,
        key: 'test-limit-key-123',
      },
    ])
  })

  it('accepts a hosted ses_ ID as the box', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`)
        return jsonResponse(operation({ id: 'op_hosted_box' }), 202)
      }),
    )

    await SnapshotSave.run([...runArguments(), HOSTED_SESSION_ID, '--no-wait'], {
      root: process.cwd(),
    })

    expect(process.exitCode ?? 0).toBe(0)
    expect(calls).toEqual([`POST /v1/sessions/${HOSTED_SESSION_ID}/snapshots`])
  })

  it('prints api_session_not_found for an unknown box', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`)
        return jsonResponse(notFoundEnvelope('api_resource_not_found'), 404)
      }),
    )

    await SnapshotSave.run([...runArguments(), UNKNOWN_SESSION_ID], { root: process.cwd() })

    expect(process.exitCode).toBe(1)
    expect(output(stderrSpy)).toContain('Reason api_session_not_found.')
    expect(calls).toEqual([`POST /v1/sessions/${UNKNOWN_SESSION_ID}/snapshots`])
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
      { method: 'GET', path: `/v1/sessions/${HOSTED_SESSION_ID}/snapshots`, key: null },
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
    expect(calls).toEqual([`/v1/sessions/${OTHER_HOSTED_SESSION_ID}/snapshots`])
    expect(output(stdoutSpy)).toBe('No snapshots\n')
  })

  it('accepts a hosted ses_ ID as the box', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        calls.push(new URL(String(input)).pathname)
        return jsonResponse({ snapshots: [] })
      }),
    )

    await SnapshotList.run([...runArguments(), HOSTED_SESSION_ID], { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    expect(calls).toEqual([`/v1/sessions/${HOSTED_SESSION_ID}/snapshots`])
    expect(output(stdoutSpy)).toBe('No snapshots\n')
  })

  it('prints api_session_not_found for an unknown box', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        calls.push(new URL(String(input)).pathname)
        return jsonResponse(notFoundEnvelope('api_resource_not_found'), 404)
      }),
    )

    await SnapshotList.run([...runArguments(), UNKNOWN_SESSION_ID], { root: process.cwd() })

    expect(process.exitCode).toBe(1)
    expect(output(stderrSpy)).toContain('Reason api_session_not_found.')
    expect(calls).toEqual([`/v1/sessions/${UNKNOWN_SESSION_ID}/snapshots`])
  })

  it('refuses a Sandbox ID instead of sending it as a Session', async () => {
    const state = await lifecycleState()
    const sandboxId = Object.keys(state.sandboxes)[0]
    if (sandboxId === undefined) throw new Error('the fixture has no Sandbox')
    const fetch = vi.fn(async () => jsonResponse({ snapshots: [] }))
    vi.stubGlobal('fetch', fetch)

    await SnapshotList.run([...runArguments(), sandboxId], { root: process.cwd() })

    expect(process.exitCode).toBe(1)
    expect(output(stderrSpy)).toContain('That is a Sandbox ID, not a Session ID')
    expect(output(stderrSpy)).toContain('`ocbox ls`')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses the current login mapping, not a newer record from another login', async () => {
    const accountState = await resolveAccountStateDirectory(
      { config, 'state-dir': state },
      state,
      true,
    )
    const store = new LifecycleStore(accountState, projectIdForPath(resolve(process.cwd())))
    const current = await store.load()
    const mapping = Object.values(current.hostedMappings)
      .flatMap((records) => Object.values(records))
      .find((record) => record.localSessionId === SESSION_ID && !record.deleted)
    if (mapping === undefined) throw new Error('the fixture has no hosted mapping')
    const decoyId = '99999999-9999-4999-8999-999999999999' as typeof mapping.localId
    await store.update((latest) => ({
      ...latest,
      hostedMappings: {
        ...latest.hostedMappings,
        'other-login': {
          [decoyId]: {
            ...mapping,
            localId: decoyId,
            hostedSessionId: 'ses_decoy',
            updatedAt: '2099-01-01T00:00:00.000Z',
          },
        },
      },
    }))
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        calls.push(new URL(String(input)).pathname)
        return jsonResponse({ snapshots: [] })
      }),
    )

    await SnapshotList.run(runArguments(), { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    expect(calls).toEqual([`/v1/sessions/${HOSTED_SESSION_ID}/snapshots`])
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
        path: `/v1/sessions/${HOSTED_SESSION_ID}/snapshots/snap_1/restore`,
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

  it('maps a terminal snapshot_not_found to a non-retryable error', async () => {
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

    await SnapshotRestore.run([...runArguments(), 'snap_missing', '--json'], {
      root: process.cwd(),
    })

    expect(process.exitCode).toBe(1)
    const envelope = JSON.parse(output(stderrSpy))
    expect(envelope.data.code).toBe('INVALID_SPEC')
    expect(envelope.data.retryable).toBe(false)
    expect(envelope.data.details.reasonCode).toBe('snapshot_not_found')
    expect(envelope.data.details.nextStep).toBe(
      'Call `ocbox snapshot list` to see the snapshots this box keeps.',
    )
  })

  it('prints api_session_not_found for an unknown box', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`)
        return jsonResponse(notFoundEnvelope('api_session_not_found'), 404)
      }),
    )

    await SnapshotRestore.run([...runArguments(), 'snap_1', UNKNOWN_SESSION_ID], {
      root: process.cwd(),
    })

    expect(process.exitCode).toBe(1)
    expect(output(stderrSpy)).toContain('Reason api_session_not_found.')
    expect(calls).toEqual([`POST /v1/sessions/${UNKNOWN_SESSION_ID}/snapshots/snap_1/restore`])
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
        path: `/v1/sessions/${HOSTED_SESSION_ID}/snapshots/snap_1`,
        key: 'test-delete-key-123',
      },
      { method: 'GET', path: '/v1/operations/op_delete', key: null },
    ])
  })

  it('prints snapshot_not_found from a direct refusal and maps the 404 to a sandbox', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 'NOT_FOUND',
              message: 'Snapshot snap_missing was not found',
              nextStep: 'Call snapshot_list to see the snapshots this box keeps.',
              reasonCode: 'snapshot_not_found',
              retryable: false,
            },
            requestId: 'request-1',
          },
          404,
        ),
      ),
    )

    await SnapshotDelete.run([...runArguments(), 'snap_missing', '--json'], {
      root: process.cwd(),
    })

    expect(process.exitCode).toBe(1)
    const envelope = JSON.parse(output(stderrSpy))
    expect(envelope.data.code).toBe('SANDBOX_NOT_FOUND')
    expect(envelope.data.retryable).toBe(false)
    expect(envelope.data.details.reasonCode).toBe('snapshot_not_found')
    expect(envelope.data.details.nextStep).toBe(
      'Call `ocbox snapshot list` to see the snapshots this box keeps.',
    )
  })

  it('prints api_session_not_found for an unknown box', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`)
        return jsonResponse(notFoundEnvelope('api_session_not_found'), 404)
      }),
    )

    await SnapshotDelete.run([...runArguments(), 'snap_1', UNKNOWN_SESSION_ID], {
      root: process.cwd(),
    })

    expect(process.exitCode).toBe(1)
    expect(output(stderrSpy)).toContain('Reason api_session_not_found.')
    expect(calls).toEqual([`DELETE /v1/sessions/${UNKNOWN_SESSION_ID}/snapshots/snap_1`])
  })
})

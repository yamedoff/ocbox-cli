import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SCOPES } from '../../src/auth/config.js'
import { AuthMetadataStore } from '../../src/auth/metadata.js'
import { createCredentialStore, defaultCredentialKey } from '../../src/auth/runtime.js'
import { createLifecycleService, DEFAULT_PROJECT_CONFIG } from '../../src/cli/runtime.js'
import { OperationIdSchema, SessionIdSchema } from '../../src/domain/ids.js'
import { UtcTimestampSchema } from '../../src/domain/timestamps.js'
import { LifecycleStore, projectIdForPath } from '../../src/lifecycle/index.js'

const originalEnvironment = { ...process.env }
const roots: string[] = []
const servers: Array<() => Promise<void>> = []
let root: string
let workspace: string
let stateDirectory: string
let origin: string

function accountDirectory(subject: string): string {
  const key = createHash('sha256').update(subject).digest('hex').slice(0, 32)
  return join(stateDirectory, 'accounts', key)
}

async function serve(): Promise<string> {
  const server = createServer((request, response: ServerResponse) => {
    if (request.url === '/v1/auth/me') {
      const subject = request.headers.authorization === 'Bearer token-b' ? 'user-b' : 'user-a'
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          subject,
          audience: 'cli',
          scopes: [...DEFAULT_SCOPES],
          expiresAt: '2026-11-08T12:00:00.000Z',
        }),
      )
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const value = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  servers.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  )
  return value
}

async function seedSession(subject: string, sessionId: string): Promise<void> {
  const projectId = projectIdForPath(workspace)
  const timestamp = UtcTimestampSchema.parse(new Date().toISOString())
  const id = SessionIdSchema.parse(sessionId)
  await new LifecycleStore(accountDirectory(subject), projectId).update((state) => ({
    ...state,
    activeSessionId: id,
    sessions: {
      ...state.sessions,
      [id]: {
        id,
        projectId,
        state: 'creating',
        bindings: [],
        currentOperationId: OperationIdSchema.parse('33333333-3333-4333-8333-333333333333'),
        providerVerifiedAt: null,
        sandboxDeletionVerifiedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  }))
}

// Far enough ahead that the stored token never expires while the suite runs.
const TOKEN_EXPIRES_AT = UtcTimestampSchema.parse(
  new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
)

async function setToken(token: string): Promise<void> {
  const key = defaultCredentialKey()
  await createCredentialStore().set(key, {
    accessToken: token,
    expiresAt: TOKEN_EXPIRES_AT,
    scopes: [...DEFAULT_SCOPES],
    tokenType: 'Bearer',
  })
  await new AuthMetadataStore(join(stateDirectory, 'auth.json')).save({
    schemaVersion: 1,
    issuer: origin,
    clientId: 'ocb_cli',
    audience: 'cli',
    scopes: [...DEFAULT_SCOPES],
    expiresAt: TOKEN_EXPIRES_AT,
    identity: key,
    updatedAt: UtcTimestampSchema.parse(new Date().toISOString()),
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ocbox-account-sessions-'))
  roots.push(root)
  workspace = join(root, 'workspace')
  stateDirectory = join(root, 'state')
  await mkdir(workspace)
  process.env['HOME'] = join(root, 'home')
  process.env['XDG_CONFIG_HOME'] = join(root, 'config')
  process.env['XDG_STATE_HOME'] = join(root, 'state-home')
  process.env['APPDATA'] = join(root, 'appdata')
  process.env['LOCALAPPDATA'] = join(root, 'localappdata')
  process.env['USERPROFILE'] = join(root, 'userprofile')
  vi.spyOn(process, 'cwd').mockReturnValue(workspace)
  origin = await serve()
  const config = DEFAULT_PROJECT_CONFIG.replace('name = "fake"', 'name = "ocbox"').replace(
    'schemaVersion = 1',
    'schemaVersion = 1\nprojectId = "44444444-4444-4444-8444-444444444444"',
  )
  await writeFile(join(workspace, 'opencloudbox.toml'), config)
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const name of Object.keys(process.env)) {
    if (!(name in originalEnvironment)) delete process.env[name]
  }
  Object.assign(process.env, originalEnvironment)
  await Promise.all(servers.splice(0).map((close) => close()))
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('account-scoped session state', () => {
  it('keeps two logins separate and restores the first list on the second login', async () => {
    const flags = { 'state-dir': stateDirectory, 'api-url': origin }
    const sessionA = '11111111-1111-4111-8111-111111111111'
    const sessionB = '22222222-2222-4222-8222-222222222222'
    await seedSession('user-a', sessionA)
    await seedSession('user-b', sessionB)

    await setToken('token-a')
    expect(
      (await (await createLifecycleService(flags)).list()).map((view) => view.session.id),
    ).toEqual([sessionA])

    await setToken('token-b')
    expect(
      (await (await createLifecycleService(flags)).list()).map((view) => view.session.id),
    ).toEqual([sessionB])

    await setToken('token-a')
    expect(
      (await (await createLifecycleService(flags)).list()).map((view) => view.session.id),
    ).toEqual([sessionA])
  })

  it('shows the boxes from both logins of the same account in one list', async () => {
    const flags = { 'state-dir': stateDirectory, 'api-url': origin }
    const firstLogin = '55555555-5555-4555-8555-555555555555'
    const secondLogin = '66666666-6666-4666-8666-666666666666'
    // Both tokens resolve to user-a through /v1/auth/me, as two logins of one
    // account do. Each login owns one box in the same account directory.
    await seedSession('user-a', firstLogin)
    await setToken('token-a-first')
    expect(
      (await (await createLifecycleService(flags)).list()).map((view) => view.session.id),
    ).toEqual([firstLogin])

    await seedSession('user-a', secondLogin)
    await setToken('token-a-second')
    expect(
      (await (await createLifecycleService(flags)).list()).map((view) => view.session.id),
    ).toEqual([firstLogin, secondLogin])
  })
})

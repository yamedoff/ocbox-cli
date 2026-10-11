import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { protocolEndpointsFromIssuer } from '../../src/auth/config.js'
import { AuthMetadataSchema, AuthMetadataStore } from '../../src/auth/metadata.js'
import { createCredentialStore, defaultCredentialKey } from '../../src/auth/runtime.js'
import { AUTH_STATE_LOCK_FILENAME } from '../../src/auth/session-gate.js'
import { credentialFromTokenPair } from '../../src/auth/token-manager.js'
import { ProjectIdSchema, SandboxIdSchema } from '../../src/contracts.js'
import { LifecycleStore } from '../../src/lifecycle/store.js'
import { createOcboxProvider } from '../../src/providers/ocbox/factory.js'
import { deferred, tokenPair } from '../auth/doubles.js'
import {
  HOSTED_PROJECT,
  HOSTED_SANDBOX,
  HOSTED_SESSION,
  LOCAL_IDS,
  hostedSessionFixture,
  jsonResponse,
  operationContext,
  testSpec,
} from '../providers/doubles.js'

// No sockets: the production factory, credential stores and file locks run
// unchanged; only fetch answers locally. Each factory models an independent CLI.
// Configurable response latency stays below the real 5s lock acquisition limit.
const requestDelayMilliseconds = Number(process.env['C14_REQUEST_DELAY_MS'] ?? 3000)

describe('issue #11: streaming transport holds the authentication gate across network waits', () => {
  let directory: string
  let cancellation: PromiseSettledResult<unknown>
  let cancelRequests = 0
  let elapsed = 0
  let lockOwner: { pid: number }
  const calls: string[] = []
  const command = new AsyncLocalStorage<string>()

  beforeAll(async () => {
    expect(requestDelayMilliseconds).toBeGreaterThanOrEqual(2000)
    expect(requestDelayMilliseconds).toBeLessThanOrEqual(3000)
    directory = await mkdtemp(join(tmpdir(), 'streaming-auth-lock-'))
    const environment = { ...process.env, XDG_CONFIG_HOME: directory, APPDATA: directory }
    const endpoints = protocolEndpointsFromIssuer('https://api.test')
    const identity = defaultCredentialKey()
    const now = Date.now()
    const credential = credentialFromTokenPair(
      { ...tokenPair('a'), scope: endpoints.scopes.join(' ') },
      now,
    )
    await createCredentialStore(environment).set(identity, credential)
    const metadata = AuthMetadataSchema.parse({
      schemaVersion: 1 as const,
      audience: 'cli' as const,
      identity,
      issuer: endpoints.issuer,
      clientId: endpoints.clientId,
      scopes: [...endpoints.scopes],
      expiresAt: credential.expiresAt,
      updatedAt: new Date(now).toISOString(),
    })
    await new AuthMetadataStore(join(directory, 'auth.json')).save(metadata)
    const scope = createHash('sha256')
      .update(
        JSON.stringify([
          metadata.issuer,
          metadata.identity,
          metadata.updatedAt,
          metadata.expiresAt,
          HOSTED_PROJECT,
        ]),
      )
      .digest('hex')
    const sandboxId = SandboxIdSchema.parse(LOCAL_IDS.sandbox)
    const store = new LifecycleStore(directory, ProjectIdSchema.parse(LOCAL_IDS.project))
    await store.update((state) => {
      state.hostedMappings[scope] = {
        [sandboxId]: {
          localId: sandboxId,
          localSessionId: LOCAL_IDS.session as never,
          localProjectId: state.projectId,
          hostedSessionId: HOSTED_SESSION,
          hostedSandboxId: HOSTED_SANDBOX,
          createdAt: metadata.updatedAt,
          updatedAt: metadata.updatedAt,
          stale: false,
          deleted: false,
          spec: testSpec() as never,
        },
      }
      return state
    })
    const polling = deferred<void>()
    let collecting = true
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      calls.push(path)
      if (path.endsWith('/events')) polling.resolve()
      if (command.getStore() === 'cancel') cancelRequests += 1
      await delay(requestDelayMilliseconds)
      if (path.endsWith(`/sessions/${HOSTED_SESSION}`)) return jsonResponse(hostedSessionFixture())
      if (init?.method === 'POST')
        return jsonResponse(
          {
            id: 'execution',
            createdAt: metadata.updatedAt,
            sessionId: HOSTED_SESSION,
            sandboxId: HOSTED_SANDBOX,
          },
          202,
        )
      if (!collecting) throw new Error('Offline collection stopped for test cleanup')
      if (path.endsWith('/events')) return jsonResponse({ data: [], nextCursor: null })
      return jsonResponse({
        id: 'execution',
        createdAt: metadata.updatedAt,
        updatedAt: metadata.updatedAt,
        sessionId: HOSTED_SESSION,
        sandboxId: HOSTED_SANDBOX,
        state: 'running',
        command: 'sleep 600',
        exitCode: null,
        failureKind: null,
        failure: null,
        truncated: false,
        outputBytes: 0,
        outputLimitBytes: 1024,
      })
    })
    const options = {
      stateDirectory: directory,
      environment,
      apiUrl: endpoints.issuer,
      projectId: HOSTED_PROJECT,
    }
    const streaming = createOcboxProvider(options)
    const cancelling = createOcboxProvider(options)
    streaming.bindLifecycleStore(store)
    cancelling.bindLifecycleStore(store)
    const handle = await command.run('exec', () =>
      streaming.exec.execute(operationContext() as never, {
        sandboxId,
        command: { mode: 'argv', argv: ['sleep', '600'] },
        environment: {},
        timeoutMilliseconds: null,
        workingDirectory: null,
      }),
    )
    await polling.promise
    lockOwner = JSON.parse(await readFile(join(directory, AUTH_STATE_LOCK_FILENAME), 'utf8'))
    const started = Date.now()
    ;[cancellation] = await Promise.allSettled([
      command.run('cancel', () => cancelling.cancelSandboxExecution(sandboxId, undefined, 30_000)),
    ])
    elapsed = Date.now() - started
    collecting = false
    // Abort the real collector through its public cancellation entrypoint.
    await streaming.exec
      .cancel(operationContext() as never, {
        executionId: handle.execution.id,
      })
      .catch(() => undefined)
    await handle.result.catch(() => undefined)
  }, 60_000)

  afterAll(async () => {
    vi.unstubAllGlobals()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('proves the local auth conflict before any cancel HTTP request', () => {
    expect(lockOwner.pid).toBe(process.pid)
    expect(cancellation).toMatchObject({
      status: 'rejected',
      reason: {
        code: 'OPERATION_CONFLICT',
        message: 'Another CLI process is updating authentication state; try again shortly',
      },
    })
    expect(cancelRequests).toBe(0)
    expect(elapsed).toBeGreaterThanOrEqual(5000)
    expect(calls.some((path) => path.endsWith('/events'))).toBe(true)
    expect(calls.some((path) => path.endsWith('/executions/execution'))).toBe(true)
  })

  it.fails('cancel should remain available while streaming requests repeatedly reacquire the auth gate', () => {
    expect(cancellation.status).toBe('fulfilled')
  })
})

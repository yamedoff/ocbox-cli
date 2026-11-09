import type { SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OcboxSandboxProvider } from '../../src/providers/ocbox/provider.js'
import { HostedSessionSchema } from '../../src/providers/ocbox/wire.js'
import { WarmSessionClient } from '../../src/warm/client.js'
import { WarmSessionServer, type WarmSessionProvider } from '../../src/warm/daemon.js'
import { warmSocketPath, type WarmSessionScope } from '../../src/warm/paths.js'
import {
  HOSTED_PROJECT,
  HOSTED_SANDBOX,
  HOSTED_SESSION,
  hostedSessionFixture,
  jsonResponse,
  LOCAL_IDS,
  operationContext,
  seededApi,
  testSpec,
} from '../providers/doubles.js'

const directories: string[] = []
const servers: WarmSessionServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

function sessionFixture() {
  return HostedSessionSchema.parse(hostedSessionFixture({}))
}

function envValue(environment: NodeJS.ProcessEnv | undefined, name: string): string | undefined {
  return environment?.[name]
}

class FakeProvider implements WarmSessionProvider {
  calls = 0
  readonly #session = sessionFixture()

  async readHostedSession(_hostedSessionId: string) {
    this.calls += 1
    return this.#session
  }
}

async function scopeFor(suffix: string): Promise<{
  directory: string
  environment: NodeJS.ProcessEnv
  scope: WarmSessionScope
  socketPath: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'ocbox-warm-'))
  directories.push(directory)
  const environment: NodeJS.ProcessEnv = { XDG_RUNTIME_DIR: directory }
  const scope: WarmSessionScope = {
    apiUrl: 'https://api.test',
    projectId: `${HOSTED_PROJECT}_${suffix}`,
    stateDirectory: join(directory, 'state'),
  }
  return {
    directory,
    environment,
    scope,
    socketPath: warmSocketPath(scope, {
      environment,
      platform: process.platform,
      userId: 4321,
    }),
  }
}

async function startServer(
  socketPath: string,
  provider: WarmSessionProvider,
  options: {
    idleTimeoutMilliseconds?: number
    sessionTtlMilliseconds?: number
  } = {},
): Promise<WarmSessionServer> {
  const server = new WarmSessionServer({
    idleTimeoutMilliseconds: options.idleTimeoutMilliseconds ?? 5_000,
    provider: () => provider,
    sessionTtlMilliseconds: options.sessionTtlMilliseconds ?? 5_000,
    socketPath,
  })
  await server.listen()
  servers.push(server)
  return server
}

function clientFor(
  scope: WarmSessionScope,
  environment: NodeJS.ProcessEnv,
  socketPath: string,
): WarmSessionClient {
  return new WarmSessionClient({
    ...scope,
    environment,
    platform: process.platform,
    socketPath,
  })
}

describe('warm session daemon', () => {
  it('reuses one owned Session observation across separate client processes', async () => {
    const { environment, scope, socketPath } = await scopeFor('reuse')
    const provider = new FakeProvider()
    await startServer(socketPath, provider)
    const first = clientFor(scope, environment, socketPath)
    const second = clientFor(scope, environment, socketPath)

    expect((await first.get(HOSTED_SESSION))?.id).toBe(HOSTED_SESSION)
    expect(provider.calls).toBe(1)
    expect((await second.get(HOSTED_SESSION))?.id).toBe(HOSTED_SESSION)
    expect(provider.calls).toBe(1)
  })

  it('serves a later provider command without another session GET', async () => {
    const { environment, scope, socketPath } = await scopeFor('provider')
    let sessionGets = 0
    const { api } = await seededApi((input, init) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.endsWith(`/sessions/${HOSTED_SESSION}`) && method === 'GET') {
        sessionGets += 1
        return Promise.resolve(jsonResponse(hostedSessionFixture({})))
      }
      return Promise.resolve(jsonResponse({}))
    })
    const daemonProvider = new OcboxSandboxProvider({ api, hostedProjectId: HOSTED_PROJECT })
    daemonProvider.seedForTests({
      hostedSandboxId: HOSTED_SANDBOX,
      hostedSessionId: HOSTED_SESSION,
      localId: LOCAL_IDS.sandbox,
      localProjectId: LOCAL_IDS.project,
      localSessionId: LOCAL_IDS.session,
      spec: testSpec() as never,
    })
    await startServer(socketPath, daemonProvider)
    const cache = clientFor(scope, environment, socketPath)
    const seed = (provider: OcboxSandboxProvider): void => {
      provider.seedForTests({
        hostedSandboxId: HOSTED_SANDBOX,
        hostedSessionId: HOSTED_SESSION,
        localId: LOCAL_IDS.sandbox,
        localProjectId: LOCAL_IDS.project,
        localSessionId: LOCAL_IDS.session,
        spec: testSpec() as never,
      })
    }
    const context = operationContext()

    const first = new OcboxSandboxProvider({
      api,
      hostedProjectId: HOSTED_PROJECT,
      sessionCache: cache,
    })
    seed(first)
    await first.get(context as never, { sandboxId: LOCAL_IDS.sandbox } as never)
    expect(sessionGets).toBe(1)

    const later = new OcboxSandboxProvider({
      api,
      hostedProjectId: HOSTED_PROJECT,
      sessionCache: cache,
    })
    seed(later)
    const observed = await later.get(
      context as never,
      {
        sandboxId: LOCAL_IDS.sandbox,
      } as never,
    )
    expect(observed?.id).toBe(LOCAL_IDS.sandbox)
    expect(sessionGets).toBe(1)
  })

  it('accepts a direct read so the next command can reuse it', async () => {
    const { environment, scope, socketPath } = await scopeFor('remember')
    const provider = new FakeProvider()
    await startServer(socketPath, provider)
    const first = clientFor(scope, environment, socketPath)
    await first.remember(HOSTED_SESSION, sessionFixture())
    const second = clientFor(scope, environment, socketPath)

    expect((await second.get(HOSTED_SESSION))?.id).toBe(HOSTED_SESSION)
    expect(provider.calls).toBe(0)
  })

  it('seeds a daemon that starts after the first command read', async () => {
    const { environment, scope, socketPath } = await scopeFor('seed')
    const provider = new FakeProvider()
    const client = new WarmSessionClient({
      ...scope,
      daemonEntry: '/tmp/ocbox-warm-daemon.js',
      daemonEntryExists: () => true,
      environment,
      platform: process.platform,
      socketPath,
      spawn: () => {
        setTimeout(() => {
          void startServer(socketPath, provider).catch(() => undefined)
        }, 30)
        return { unref: () => undefined }
      },
    })

    await client.remember(HOSTED_SESSION, sessionFixture())
    const later = clientFor(scope, environment, socketPath)
    expect((await later.get(HOSTED_SESSION))?.id).toBe(HOSTED_SESSION)
    expect(provider.calls).toBe(0)
  })

  it('falls back to the direct path when no daemon is listening', async () => {
    const { environment, scope, socketPath } = await scopeFor('fallback')
    const client = clientFor(scope, environment, socketPath)

    await expect(client.get(HOSTED_SESSION)).resolves.toBeNull()
    expect(existsSync(socketPath)).toBe(false)
  })

  it('starts the daemon on first use when the socket is absent', async () => {
    const { environment, scope, socketPath } = await scopeFor('spawn')
    const spawnCalls: Array<{
      command: string
      args: readonly string[]
      options: SpawnOptions
    }> = []
    const client = new WarmSessionClient({
      ...scope,
      daemonEntry: '/tmp/ocbox-warm-daemon.js',
      daemonEntryExists: () => true,
      environment,
      platform: process.platform,
      socketPath,
      spawn: (command, args, options) => {
        spawnCalls.push({ args, command, options })
        return { unref: () => undefined }
      },
    })

    await expect(client.get(HOSTED_SESSION)).resolves.toBeNull()
    expect(spawnCalls).toHaveLength(1)
    const call = spawnCalls[0]
    expect(call?.command).toBe(process.execPath)
    expect(call?.args).toEqual(['/tmp/ocbox-warm-daemon.js'])
    expect(call?.options.detached).toBe(true)
    expect(call?.options.stdio).toBe('ignore')
    expect(envValue(call?.options.env, 'OCBOX_WARM_SOCKET')).toBe(socketPath)
    expect(envValue(call?.options.env, 'OCBOX_WARM_API_URL')).toBe(scope.apiUrl)
    expect(envValue(call?.options.env, 'OCBOX_WARM_PROJECT_ID')).toBe(scope.projectId)
    expect(envValue(call?.options.env, 'OCBOX_WARM_STATE_DIR')).toBe(scope.stateDirectory)
    expect(envValue(call?.options.env, 'OCBOX_WARM_IDLE_MS')).toBe('600000')
  })

  it('does not start a daemon when OCBOX_WARM=0 is set', async () => {
    const { environment, scope, socketPath } = await scopeFor('disabled')
    let spawns = 0
    const client = new WarmSessionClient({
      ...scope,
      daemonEntry: '/tmp/ocbox-warm-daemon.js',
      daemonEntryExists: () => true,
      environment: { ...environment, OCBOX_WARM: '0' },
      platform: process.platform,
      socketPath,
      spawn: () => {
        spawns += 1
        return { unref: () => undefined }
      },
    })

    await expect(client.get(HOSTED_SESSION)).resolves.toBeNull()
    expect(spawns).toBe(0)
  })

  it('refreshes an expired observation and exits after the idle timeout', async () => {
    const { environment, scope, socketPath } = await scopeFor('idle')
    const provider = new FakeProvider()
    const server = await startServer(socketPath, provider, {
      idleTimeoutMilliseconds: 50,
      sessionTtlMilliseconds: 10,
    })
    const client = clientFor(scope, environment, socketPath)

    expect((await client.get(HOSTED_SESSION))?.id).toBe(HOSTED_SESSION)
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect((await client.get(HOSTED_SESSION))?.id).toBe(HOSTED_SESSION)
    expect(provider.calls).toBe(2)

    await server.closed
    expect(existsSync(socketPath)).toBe(false)
  })

  it('ignores a socket whose directory other users can write', async () => {
    if (process.platform === 'win32') return
    const { environment, scope, socketPath } = await scopeFor('shared-dir')
    const provider = new FakeProvider()
    await startServer(socketPath, provider)
    await chmod(dirname(socketPath), 0o777)
    const client = new WarmSessionClient({
      ...scope,
      daemonEntryExists: () => false,
      environment,
      platform: process.platform,
      socketPath,
    })
    await expect(client.get(HOSTED_SESSION)).resolves.toBeNull()
    expect(provider.calls).toBe(0)
  })
  it('creates the socket in an owner-only directory with owner-only permissions', async () => {
    if (process.platform === 'win32') return
    const { socketPath } = await scopeFor('mode')
    const provider = new FakeProvider()
    await startServer(socketPath, provider)

    const directoryMode = (await stat(dirname(socketPath))).mode & 0o777
    const socketMode = (await stat(socketPath)).mode & 0o777
    expect(directoryMode).toBe(0o700)
    expect(socketMode).toBe(0o600)
  })
})

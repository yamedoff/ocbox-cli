import type { SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
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
    platform?: NodeJS.Platform
    sessionTtlMilliseconds?: number
    stateDirectory?: string
  } = {},
): Promise<WarmSessionServer> {
  const server = new WarmSessionServer({
    idleTimeoutMilliseconds: options.idleTimeoutMilliseconds ?? 5_000,
    platform: options.platform ?? process.platform,
    provider: () => provider,
    sessionTtlMilliseconds: options.sessionTtlMilliseconds ?? 5_000,
    socketPath,
    stateDirectory: options.stateDirectory,
  })
  await server.listen()
  servers.push(server)
  return server
}

function clientFor(
  scope: WarmSessionScope,
  environment: NodeJS.ProcessEnv,
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): WarmSessionClient {
  return new WarmSessionClient({
    ...scope,
    environment,
    platform,
    socketPath,
  })
}

/**
 * A base path short enough for a Unix socket plus the daemon's random suffix
 * when the test forces win32 on a non-Windows host; on Windows it is a pipe.
 */
async function handshakeScopeFor(suffix: string): Promise<{
  directory: string
  environment: NodeJS.ProcessEnv
  scope: WarmSessionScope
  socketPath: string
}> {
  const root = process.platform === 'win32' ? tmpdir() : '/tmp'
  const directory = await mkdtemp(join(root, 'ocbox-warm-'))
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
    socketPath:
      process.platform === 'win32'
        ? warmSocketPath(scope, { platform: 'win32', userId: 4321 })
        : join(directory, 'warm.sock'),
  }
}

interface TestConnection {
  readonly file: string
  readonly pipe: string
  readonly secret: string
}

async function connectionFor(stateDirectory: string): Promise<TestConnection> {
  const directory = join(stateDirectory, 'warm')
  const names = await readdir(directory)
  const file = join(directory, names.find((name) => name.endsWith('.json')) ?? '')
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('The test expected a published connection')
  }
  const { pipe, secret } = parsed as { pipe?: unknown; secret?: unknown }
  if (typeof pipe !== 'string' || typeof secret !== 'string') {
    throw new Error('The test expected a published connection')
  }
  return { file, pipe, secret }
}

function isListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath)
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1_000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function rawRequest(pipe: string, message: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection(pipe)
    let data = ''
    let settled = false
    const done = (value: string): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1_000, () => done('timeout'))
    socket.on('data', (chunk) => {
      data += chunk.toString()
    })
    socket.once('error', () => done(data))
    socket.once('close', () => done(data))
    socket.once('connect', () => socket.write(message))
  })
}

describe('warm session daemon', () => {
  it('reuses one owned Session observation across separate client processes', async () => {
    const { environment, scope, socketPath } = await scopeFor('reuse')
    const provider = new FakeProvider()
    await startServer(socketPath, provider, { stateDirectory: scope.stateDirectory })
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
    await startServer(socketPath, daemonProvider, { stateDirectory: scope.stateDirectory })
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
    await startServer(socketPath, provider, { stateDirectory: scope.stateDirectory })
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
          void startServer(socketPath, provider, {
            stateDirectory: scope.stateDirectory,
          }).catch(() => undefined)
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
    expect(call?.options.cwd).toBe(tmpdir())
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
      stateDirectory: scope.stateDirectory,
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

describe('windows named-pipe owner check', () => {
  it('serves a client that presents the published secret', async () => {
    const { environment, scope, socketPath } = await handshakeScopeFor('win32-secret')
    const provider = new FakeProvider()
    await startServer(socketPath, provider, {
      platform: 'win32',
      stateDirectory: scope.stateDirectory,
    })
    const client = clientFor(scope, environment, socketPath, 'win32')

    expect((await client.get(HOSTED_SESSION))?.id).toBe(HOSTED_SESSION)
    expect(provider.calls).toBe(1)
    // The deterministic name stays connectable so existing harnesses can wait
    // for the daemon, but it never answers a protocol request.
    expect(await isListening(socketPath)).toBe(true)

    const connection = await connectionFor(scope.stateDirectory)
    expect(connection.pipe).not.toBe(socketPath)
    expect(connection.pipe.startsWith(`${socketPath}-`)).toBe(true)
    // At least 128 random bits in the pipe name.
    expect(connection.pipe.slice(socketPath.length + 1)).toMatch(/^[0-9a-f]{32,}$/)
    expect(connection.secret).toMatch(/^[0-9a-f]{64}$/)
    if (process.platform !== 'win32') {
      const mode = (await stat(connection.file)).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('does not answer a request without the secret and the client falls back', async () => {
    const { environment, scope, socketPath } = await handshakeScopeFor('win32-no-secret')
    const provider = new FakeProvider()
    await startServer(socketPath, provider, {
      platform: 'win32',
      stateDirectory: scope.stateDirectory,
    })
    const connection = await connectionFor(scope.stateDirectory)

    const reply = await rawRequest(connection.pipe, `${JSON.stringify({ op: 'ping', v: 1 })}\n`)
    expect(reply).toBe('')

    // A published file without a secret cannot be used: the CLI falls back.
    await writeFile(connection.file, JSON.stringify({ pipe: connection.pipe }), { mode: 0o600 })
    const client = new WarmSessionClient({
      ...scope,
      daemonEntryExists: () => false,
      environment,
      platform: 'win32',
      socketPath,
    })
    await expect(client.get(HOSTED_SESSION)).resolves.toBeNull()
    expect(provider.calls).toBe(0)
  })

  it('does not answer a request with a wrong secret and the client falls back', async () => {
    const { environment, scope, socketPath } = await handshakeScopeFor('win32-wrong-secret')
    const provider = new FakeProvider()
    await startServer(socketPath, provider, {
      platform: 'win32',
      stateDirectory: scope.stateDirectory,
    })
    const connection = await connectionFor(scope.stateDirectory)
    const wrongSecret = '00'.repeat(32)

    const reply = await rawRequest(
      connection.pipe,
      `${JSON.stringify({ op: 'ping', secret: wrongSecret, v: 1 })}\n`,
    )
    expect(reply).toBe('')

    await writeFile(
      connection.file,
      JSON.stringify({ pipe: connection.pipe, secret: wrongSecret }),
      { mode: 0o600 },
    )
    const client = new WarmSessionClient({
      ...scope,
      daemonEntryExists: () => false,
      environment,
      platform: 'win32',
      socketPath,
    })
    await expect(client.get(HOSTED_SESSION)).resolves.toBeNull()
    expect(provider.calls).toBe(0)
  })

  it('makes the old secret fail after a restart', async () => {
    const { environment, scope, socketPath } = await handshakeScopeFor('win32-restart')
    const provider = new FakeProvider()
    const first = await startServer(socketPath, provider, {
      platform: 'win32',
      stateDirectory: scope.stateDirectory,
    })
    const oldConnection = await connectionFor(scope.stateDirectory)
    await first.close()

    await startServer(socketPath, provider, {
      platform: 'win32',
      stateDirectory: scope.stateDirectory,
    })
    const newConnection = await connectionFor(scope.stateDirectory)
    expect(newConnection.pipe).not.toBe(oldConnection.pipe)
    expect(newConnection.secret).not.toBe(oldConnection.secret)

    const reply = await rawRequest(
      newConnection.pipe,
      `${JSON.stringify({ op: 'ping', secret: oldConnection.secret, v: 1 })}\n`,
    )
    expect(reply).toBe('')

    const client = clientFor(scope, environment, socketPath, 'win32')
    expect((await client.get(HOSTED_SESSION))?.id).toBe(HOSTED_SESSION)
    expect(provider.calls).toBe(1)
  })
})

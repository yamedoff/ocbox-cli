import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { protocolEndpointsFromIssuer } from '../../src/auth/config.js'
import { AuthBindingError } from '../../src/auth/errors.js'
import { AuthMetadataSchema, AuthMetadataStore } from '../../src/auth/metadata.js'
import {
  createHostedTokenManager,
  createRefreshGate,
  resolveAuthEndpoints,
  resolveAuthStateDirectory,
} from '../../src/auth/runtime.js'
import { credentialFromTokenPair } from '../../src/auth/token-manager.js'
import { AUTH_STATE_LOCK_FILENAME, createSessionGate } from '../../src/auth/session-gate.js'
import { OcboxError } from '../../src/errors/index.js'
import { ExclusiveFileLock } from '../../src/state/exclusive-file-lock.js'
import {
  deferred,
  fixedClock,
  MemoryCredentialStore,
  TEST_KEY,
  TEST_NOW,
  tokenPair,
} from './doubles.js'

const directories: string[] = []

async function temporaryStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ocbox-auth-runtime-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

const endpoints = protocolEndpointsFromIssuer('https://api.test')

function metadataInput(overrides: { issuer?: string; clientId?: string } = {}) {
  return {
    audience: 'cli' as const,
    clientId: overrides.clientId ?? endpoints.clientId,
    expiresAt: new Date(TEST_NOW + 900_000).toISOString(),
    identity: TEST_KEY,
    issuer: overrides.issuer ?? endpoints.issuer,
    schemaVersion: 1 as const,
    scopes: ['source:read'],
    updatedAt: new Date(TEST_NOW).toISOString(),
  }
}

describe('auth runtime resolution', () => {
  it('defaults login to the canonical consent page under the API base', () => {
    const resolved = resolveAuthEndpoints({ 'api-url': 'https://api.example.test' }, {})
    expect(resolved.authorizationEndpoint).toBe('https://api.example.test/v1/auth/cli/authorize')
  })

  it('keeps validator detail when the API base URL shape is rejected', () => {
    let error: unknown = null
    try {
      resolveAuthEndpoints(
        {
          'api-url': 'https://user:pass@api.example.test',
          'authorize-url': 'https://web.example.test/authorize',
        },
        {},
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(OcboxError)
    expect((error as OcboxError).code).toBe('CONFIG_INVALID')
    expect((error as Error).message).toContain('must not embed credentials')
  })

  it('resolves the login endpoints from flags and environment', () => {
    const resolved = resolveAuthEndpoints(
      { 'api-url': 'https://api.example.test' },
      { OCBOX_AUTHORIZE_URL: 'https://web.example.test/authorize' },
    )
    expect(resolved.issuer).toBe('https://api.example.test')
    expect(resolved.authorizationEndpoint).toBe('https://web.example.test/authorize')
    expect(resolved.tokenEndpoint).toBe('https://api.example.test/v1/auth/cli/token')
  })

  it('resolves one absolute state directory from explicit input, flags, or environment', () => {
    expect(resolveAuthStateDirectory({ stateDirectory: 'custom-dir' })).toBe(resolve('custom-dir'))
    expect(
      resolveAuthStateDirectory({
        environment: { OCBOX_STATE_DIR: 'env-dir' },
        flags: { 'state-dir': 'flag-dir' },
      }),
    ).toBe(resolve('flag-dir'))
    expect(resolveAuthStateDirectory({ environment: { OCBOX_STATE_DIR: 'env-dir' } })).toBe(
      resolve('env-dir'),
    )
  })
})

describe('hosted token manager runtime construction', () => {
  it('fails closed unless the caller supplies the exact resolved state directory', () => {
    expect(() =>
      createHostedTokenManager({
        credentialStore: new MemoryCredentialStore(),
        endpoints,
        stateDirectory: 'relative/state',
      }),
    ).toThrow(OcboxError)
  })

  it('binds the credential to metadata from the caller-supplied state directory', async () => {
    const stateDirectory = await temporaryStateDirectory()
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    const metadata = new AuthMetadataStore(join(stateDirectory, 'auth.json'))
    await metadata.save(AuthMetadataSchema.parse(metadataInput()))
    const manager = createHostedTokenManager({
      clock: fixedClock(TEST_NOW),
      credentialStore: store,
      endpoints,
      fetch: () => Promise.reject(new Error('the network must not run')),
      stateDirectory,
    })

    await expect(manager.getValidCredential()).resolves.toMatchObject({
      accessToken: 'a'.repeat(48),
    })
    expect(manager.boundIssuer).toBe(endpoints.issuer)
  })

  it('fails closed when the binding metadata lives in a different state directory', async () => {
    const stateDirectory = await temporaryStateDirectory()
    const otherDirectory = await temporaryStateDirectory()
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    const metadata = new AuthMetadataStore(join(otherDirectory, 'auth.json'))
    await metadata.save(AuthMetadataSchema.parse(metadataInput()))
    const manager = createHostedTokenManager({
      clock: fixedClock(TEST_NOW),
      credentialStore: store,
      endpoints,
      stateDirectory,
    })

    await expect(manager.getValidCredential()).rejects.toBeInstanceOf(AuthBindingError)
  })

  it('binds the credential to the configured client id', async () => {
    const stateDirectory = await temporaryStateDirectory()
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    const metadata = new AuthMetadataStore(join(stateDirectory, 'auth.json'))
    await metadata.save(AuthMetadataSchema.parse(metadataInput({ clientId: 'other_client' })))
    const manager = createHostedTokenManager({
      clock: fixedClock(TEST_NOW),
      credentialStore: store,
      endpoints,
      stateDirectory,
    })

    await expect(manager.getValidCredential()).rejects.toBeInstanceOf(AuthBindingError)
  })
})

describe('refresh gate', () => {
  it('uses the same outer lock as session state commits', async () => {
    const stateDirectory = await temporaryStateDirectory()
    const release = deferred<void>()
    const holder = createSessionGate(stateDirectory)(() => release.promise)
    await vi.waitFor(() =>
      expect(existsSync(join(stateDirectory, AUTH_STATE_LOCK_FILENAME))).toBe(true),
    )

    let refreshRan = false
    const refresh = createRefreshGate(stateDirectory)(async () => {
      refreshRan = true
    })
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    expect(refreshRan).toBe(false)

    release.resolve()
    await Promise.all([holder, refresh])
    expect(refreshRan).toBe(true)
  })

  it('maps a cancelled wait for another process to a typed cancellation error', async () => {
    const stateDirectory = await temporaryStateDirectory()
    const gate = createRefreshGate(stateDirectory)
    const lockPath = join(stateDirectory, AUTH_STATE_LOCK_FILENAME)
    const blocker = new ExclusiveFileLock({
      createCancelledError: () => new Error('test-cancelled'),
      createTimeoutError: () => new Error('test-timeout'),
    })
    let release!: () => void
    const holder = blocker.withLock(
      lockPath,
      undefined,
      () =>
        new Promise<void>((resolveHolder) => {
          release = resolveHolder
        }),
    )
    await vi.waitFor(() => expect(existsSync(lockPath)).toBe(true))

    const controller = new AbortController()
    const waiter = gate(async () => 'ran', controller.signal)
    controller.abort()
    await expect(waiter).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    release()
    await holder
  })
})

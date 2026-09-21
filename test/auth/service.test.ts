import { request as httpRequest } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { authEndpointsFromIssuer } from '../../src/auth/config.js'
import type { EntropyPort } from '../../src/auth/entropy.js'
import { newRequestId } from '../../src/auth/errors.js'
import { startLoopbackListener } from '../../src/auth/loopback.js'
import { AuthMetadataSchema, type AuthMetadata } from '../../src/auth/metadata.js'
import type { HostedOAuthCredentialKey } from '../../src/credentials/index.js'
import type {
  CliOAuthClientPort,
  ExchangeAuthorizationCodeInput,
} from '../../src/auth/oauth-client.js'
import { codeChallengeS256 } from '../../src/auth/pkce.js'
import { AuthSessionService } from '../../src/auth/service.js'
import { credentialFromTokenPair } from '../../src/auth/token-manager.js'
import { OcboxError } from '../../src/errors/index.js'
import {
  concurrencyTrackingGate,
  failingGate,
  fixedClock,
  MemoryCredentialStore,
  MemoryMetadataRepository,
  TEST_KEY,
  TEST_NOW,
  tokenPair,
} from './doubles.js'

const CODE = 'authorization-code-value-'.padEnd(40, 'x')

class CountingEntropy implements EntropyPort {
  #value = 0

  randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length)
    for (let index = 0; index < length; index += 1) {
      this.#value = (this.#value + 7) % 256
      bytes[index] = this.#value
    }
    return bytes
  }
}

function sendCallback(redirectUri: string, code: string, state: string): Promise<void> {
  const url = new URL(redirectUri)
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: url.hostname,
        method: 'GET',
        path: `/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
        port: Number(url.port),
      },
      (response) => {
        response.resume()
        response.on('end', () => resolve())
      },
    )
    request.on('error', reject)
    request.end()
  })
}

interface Harness {
  readonly service: AuthSessionService
  readonly credentials: MemoryCredentialStore
  readonly metadata: MemoryMetadataRepository
  readonly exchangeCalls: ExchangeAuthorizationCodeInput[]
  readonly revokeCalls: Array<{ token: string }>
  readonly open: ReturnType<typeof vi.fn>
}

function harness(
  options: {
    exchange?: (input: ExchangeAuthorizationCodeInput) => Promise<ReturnType<typeof tokenPair>>
    revoke?: () => Promise<void>
    openResult?: boolean
  } = {},
): Harness {
  const credentials = new MemoryCredentialStore()
  const metadata = new MemoryMetadataRepository()
  const exchangeCalls: ExchangeAuthorizationCodeInput[] = []
  const revokeCalls: Array<{ token: string }> = []
  const oauthPort: CliOAuthClientPort = {
    exchangeAuthorizationCode: async (input) => {
      exchangeCalls.push(input)
      return options.exchange === undefined ? tokenPair('a') : options.exchange(input)
    },
    refresh: () => Promise.resolve(tokenPair('b')),
    revoke: async (input) => {
      revokeCalls.push({ token: input.token })
      if (options.revoke !== undefined) await options.revoke()
    },
  }
  const open = vi.fn(() => Promise.resolve(options.openResult ?? true))
  const service = new AuthSessionService({
    browser: { open },
    clock: fixedClock(TEST_NOW),
    credentialKey: TEST_KEY,
    credentialStore: credentials,
    endpoints: authEndpointsFromIssuer('https://api.example.test', {
      authorizationEndpoint: 'https://web.example.test/authorize',
    }),
    entropy: new CountingEntropy(),
    listenerFactory: startLoopbackListener,
    loginTimeoutMilliseconds: 5_000,
    metadataStore: metadata,
    oauth: () => oauthPort,
  })
  return { credentials, exchangeCalls, metadata, open, revokeCalls, service }
}

describe('auth session service', () => {
  it('completes a login over the loopback callback with S256 PKCE and stores only through the credential port', async () => {
    const h = harness({ openResult: false })
    const authorizationUrls: Array<{ opened: boolean; url: string }> = []
    const result = await h.service.login({
      onAuthorizationUrl: (url, opened) => {
        authorizationUrls.push({ opened, url })
        const parsed = new URL(url)
        const redirectUri = parsed.searchParams.get('redirect_uri') ?? ''
        const state = parsed.searchParams.get('state') ?? ''
        setTimeout(() => void sendCallback(redirectUri, CODE, state), 10)
      },
      openBrowser: false,
    })

    expect(result.loggedIn).toBe(true)
    expect(result.browserOpened).toBe(false)
    expect(authorizationUrls).toHaveLength(1)
    expect(authorizationUrls[0]?.opened).toBe(false)

    const call = h.exchangeCalls[0]
    expect(call).toBeDefined()
    expect(call?.code).toBe(CODE)
    expect(call?.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const challenge = new URL(authorizationUrls[0]?.url ?? 'https://x.test').searchParams.get(
      'code_challenge',
    )
    expect(codeChallengeS256(call?.codeVerifier ?? '')).toBe(challenge)

    expect(h.credentials.sets).toHaveLength(1)
    expect(h.credentials.sets[0]?.accessToken).toBe('a'.repeat(48))
    expect(h.credentials.sets[0]?.refreshToken).toBe('A'.repeat(48))
    const metadata = h.metadata.value
    expect(metadata?.issuer).toBe('https://api.example.test')
    expect(metadata?.audience).toBe('cli')
    expect(JSON.stringify(metadata)).not.toContain('a'.repeat(48))
    expect(JSON.stringify(metadata)).not.toContain('A'.repeat(48))
    expect(JSON.stringify(metadata)).not.toContain(CODE)
  })

  it('opens the browser when available and reports it', async () => {
    const h = harness({ openResult: true })
    const result = await h.service.login({
      onAuthorizationUrl: (url) => {
        const redirectUri = new URL(url).searchParams.get('redirect_uri') ?? ''
        const state = new URL(url).searchParams.get('state') ?? ''
        setTimeout(() => void sendCallback(redirectUri, CODE, state), 10)
      },
    })
    expect(result.browserOpened).toBe(true)
    expect(h.open).toHaveBeenCalledTimes(1)
  })

  it('does not persist anything when the token exchange fails', async () => {
    const h = harness({
      exchange: () =>
        Promise.reject(
          new OcboxError({
            code: 'AUTH_REQUIRED',
            message: 'invalid grant',
            requestId: newRequestId(),
          }),
        ),
    })
    await expect(
      h.service.login({
        openBrowser: false,
        onAuthorizationUrl: (url) => {
          const redirectUri = new URL(url).searchParams.get('redirect_uri') ?? ''
          const state = new URL(url).searchParams.get('state') ?? ''
          setTimeout(() => void sendCallback(redirectUri, CODE, state), 10)
        },
      }),
    ).rejects.toBeInstanceOf(OcboxError)
    expect(h.credentials.sets).toHaveLength(0)
    expect(h.metadata.value).toBeNull()
  })

  it('reports status facts and expiry without exposing secret values', async () => {
    const h = harness()
    await h.credentials.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    h.metadata.value = AuthMetadataSchema.parse({
      audience: 'cli',
      clientId: 'ocb_cli',
      expiresAt: new Date(TEST_NOW + 900_000).toISOString(),
      identity: TEST_KEY,
      issuer: 'https://api.example.test',
      schemaVersion: 1,
      scopes: ['source:read'],
      updatedAt: new Date(TEST_NOW).toISOString(),
    })
    const status = await h.service.status()
    expect(status).toMatchObject({
      audience: 'cli',
      expired: false,
      issuer: 'https://api.example.test',
      loggedIn: true,
      scopes: ['source:read'],
    })
    expect(JSON.stringify(status)).not.toContain('a'.repeat(48))
  })

  it('fails status closed when a credential exists without matching metadata', async () => {
    const h = harness()
    await h.credentials.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))

    await expect(h.service.status()).rejects.toMatchObject({ code: 'INVALID_STATE' })
    // Status is read-only for an orphaned secret; explicit logout owns cleanup.
    await expect(h.credentials.get(TEST_KEY)).resolves.toMatchObject({
      accessToken: 'a'.repeat(48),
    })
  })

  it('fails status closed when metadata names a different credential generation', async () => {
    const h = harness()
    await h.credentials.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    h.metadata.value = AuthMetadataSchema.parse({
      audience: 'cli',
      clientId: 'ocb_cli',
      expiresAt: new Date(TEST_NOW + 900_000).toISOString(),
      identity: TEST_KEY,
      issuer: 'https://api.example.test',
      schemaVersion: 1,
      scopes: ['different:scope'],
      updatedAt: new Date(TEST_NOW).toISOString(),
    })

    await expect(h.service.status()).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(h.metadata.value?.scopes).toEqual(['different:scope'])
    await expect(h.credentials.get(TEST_KEY)).resolves.not.toBeNull()
  })

  it('clears stale metadata when the credential is missing and reports logout on expiry', async () => {
    const h = harness()
    h.metadata.value = AuthMetadataSchema.parse({
      audience: 'cli',
      clientId: 'ocb_cli',
      expiresAt: new Date(TEST_NOW - 1_000).toISOString(),
      identity: TEST_KEY,
      issuer: 'https://api.example.test',
      schemaVersion: 1,
      scopes: ['source:read'],
      updatedAt: new Date(TEST_NOW - 2_000).toISOString(),
    })
    const missing = await h.service.status()
    expect(missing.loggedIn).toBe(false)
    expect(h.metadata.value).toBeNull()

    await h.credentials.set(TEST_KEY, credentialFromTokenPair(tokenPair('a', -1), TEST_NOW))
    h.metadata.value = AuthMetadataSchema.parse({
      audience: 'cli',
      clientId: 'ocb_cli',
      expiresAt: new Date(TEST_NOW - 1_000).toISOString(),
      identity: TEST_KEY,
      issuer: 'https://api.example.test',
      schemaVersion: 1,
      scopes: ['source:read'],
      updatedAt: new Date(TEST_NOW - 2_000).toISOString(),
    })
    const expired = await h.service.status()
    expect(expired.expired).toBe(true)
    expect(expired.loggedIn).toBe(false)
  })

  it('always clears local material on logout even when revocation fails', async () => {
    const h = harness({ revoke: () => Promise.reject(new Error('server down')) })
    await h.credentials.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    h.metadata.value = AuthMetadataSchema.parse({
      audience: 'cli',
      clientId: 'ocb_cli',
      expiresAt: new Date(TEST_NOW + 900_000).toISOString(),
      identity: TEST_KEY,
      issuer: 'https://api.example.test',
      schemaVersion: 1,
      scopes: ['source:read'],
      updatedAt: new Date(TEST_NOW).toISOString(),
    })

    const result = await h.service.logout()
    expect(result).toEqual({ loggedOut: true, revocationAttempted: true, revoked: false })
    expect(h.revokeCalls).toHaveLength(1)
    expect(h.credentials.values.size).toBe(0)
    expect(h.metadata.value).toBeNull()
  })

  it('reports successful revocation', async () => {
    const h = harness()
    await h.credentials.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    h.metadata.value = AuthMetadataSchema.parse({
      audience: 'cli',
      clientId: 'ocb_cli',
      expiresAt: new Date(TEST_NOW + 900_000).toISOString(),
      identity: TEST_KEY,
      issuer: 'https://api.example.test',
      schemaVersion: 1,
      scopes: ['source:read'],
      updatedAt: new Date(TEST_NOW).toISOString(),
    })
    const result = await h.service.logout()
    expect(result.revoked).toBe(true)
    expect(h.revokeCalls[0]?.token).toBe('A'.repeat(48))
  })

  it('clears local material without sending it to an invalid stored issuer', async () => {
    const credentials = new MemoryCredentialStore()
    const metadata = new MemoryMetadataRepository()
    await credentials.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    metadata.value = AuthMetadataSchema.parse({
      audience: 'cli',
      clientId: 'ocb_cli',
      expiresAt: new Date(TEST_NOW + 900_000).toISOString(),
      identity: TEST_KEY,
      issuer: 'not-an-absolute-url',
      schemaVersion: 1,
      scopes: ['source:read'],
      updatedAt: new Date(TEST_NOW).toISOString(),
    })
    let oauthBuilt = false
    const service = new AuthSessionService({
      browser: { open: () => Promise.resolve(false) },
      clock: fixedClock(TEST_NOW),
      credentialKey: TEST_KEY,
      credentialStore: credentials,
      endpoints: null,
      entropy: new CountingEntropy(),
      listenerFactory: startLoopbackListener,
      loginTimeoutMilliseconds: 5_000,
      metadataStore: metadata,
      oauth: () => {
        oauthBuilt = true
        throw new Error('invalid endpoint must not yield a protocol client')
      },
    })

    await expect(service.logout()).resolves.toEqual({
      loggedOut: true,
      revocationAttempted: false,
      revoked: false,
    })
    expect(oauthBuilt).toBe(false)
    expect(credentials.values.size).toBe(0)
    expect(metadata.value).toBeNull()
  })
})

class FailingMetadataRepository extends MemoryMetadataRepository {
  readonly #failSave = new Set<number>()
  #saveCalls = 0

  failSaveOn(callIndex: number): void {
    this.#failSave.add(callIndex)
  }

  override async save(metadata: AuthMetadata): Promise<void> {
    this.#saveCalls += 1
    if (this.#failSave.has(this.#saveCalls)) {
      throw new Error('disk failure')
    }
    this.value = metadata
    this.saves.push(metadata)
  }
}

class FailingDeleteCredentialStore extends MemoryCredentialStore {
  failDeletes = false

  override delete(key: HostedOAuthCredentialKey): Promise<void> {
    if (this.failDeletes) return Promise.reject(new Error('disk failure'))
    return super.delete(key)
  }
}

describe('auth session service failure legs', () => {
  it('restores the previous credential and metadata when the metadata commit fails', async () => {
    const credentials = new MemoryCredentialStore()
    const metadata = new FailingMetadataRepository()
    const previous = AuthMetadataSchema.parse({
      audience: 'cli',
      clientId: 'ocb_cli',
      expiresAt: new Date(TEST_NOW + 1_000).toISOString(),
      identity: TEST_KEY,
      issuer: 'https://old.example.test',
      schemaVersion: 1,
      scopes: ['source:read'],
      updatedAt: new Date(TEST_NOW - 1_000).toISOString(),
    })
    metadata.value = previous
    const previousCredential = credentialFromTokenPair(tokenPair('a'), TEST_NOW)
    await credentials.set(TEST_KEY, previousCredential)
    const service = new AuthSessionService({
      browser: { open: () => Promise.resolve(false) },
      clock: fixedClock(TEST_NOW),
      credentialKey: TEST_KEY,
      credentialStore: credentials,
      endpoints: authEndpointsFromIssuer('https://api.example.test', {
        authorizationEndpoint: 'https://web.example.test/authorize',
      }),
      entropy: new CountingEntropy(),
      listenerFactory: startLoopbackListener,
      loginTimeoutMilliseconds: 5_000,
      metadataStore: metadata,
      oauth: () => ({
        exchangeAuthorizationCode: () => Promise.resolve(tokenPair('b')),
        refresh: () => Promise.resolve(tokenPair('b')),
        revoke: () => Promise.resolve(),
      }),
    })
    const failingSaveCalls = metadata.saves.length
    metadata.failSaveOn(failingSaveCalls + 1)
    await expect(
      service.login({
        openBrowser: false,
        onAuthorizationUrl: (url) => {
          const redirectUri = new URL(url).searchParams.get('redirect_uri') ?? ''
          const state = new URL(url).searchParams.get('state') ?? ''
          setTimeout(() => void sendCallback(redirectUri, CODE, state), 10)
        },
      }),
    ).rejects.toMatchObject({ message: 'disk failure' })
    // Exactly the previous state remains on disk.
    await expect(credentials.get(TEST_KEY)).resolves.toMatchObject({
      accessToken: 'a'.repeat(48),
    })
    expect(metadata.value).toEqual(previous)
  })

  it('persists nothing when the metadata commit fails on a clean machine', async () => {
    const credentials = new MemoryCredentialStore()
    const metadata = new FailingMetadataRepository()
    metadata.failSaveOn(1)
    const service = new AuthSessionService({
      browser: { open: () => Promise.resolve(false) },
      clock: fixedClock(TEST_NOW),
      credentialKey: TEST_KEY,
      credentialStore: credentials,
      endpoints: authEndpointsFromIssuer('https://api.example.test', {
        authorizationEndpoint: 'https://web.example.test/authorize',
      }),
      entropy: new CountingEntropy(),
      listenerFactory: startLoopbackListener,
      loginTimeoutMilliseconds: 5_000,
      metadataStore: metadata,
      oauth: () => ({
        exchangeAuthorizationCode: () => Promise.resolve(tokenPair('b')),
        refresh: () => Promise.resolve(tokenPair('b')),
        revoke: () => Promise.resolve(),
      }),
    })
    await expect(
      service.login({
        openBrowser: false,
        onAuthorizationUrl: (url) => {
          const redirectUri = new URL(url).searchParams.get('redirect_uri') ?? ''
          const state = new URL(url).searchParams.get('state') ?? ''
          setTimeout(() => void sendCallback(redirectUri, CODE, state), 10)
        },
      }),
    ).rejects.toBeTruthy()
    expect(credentials.values.size).toBe(0)
    expect(metadata.value).toBeNull()
  })

  it('reports INVALID_STATE when a failed login commit cannot be rolled back', async () => {
    const credentials = new FailingDeleteCredentialStore()
    const metadata = new FailingMetadataRepository()
    metadata.failSaveOn(1)
    credentials.failDeletes = true
    const service = new AuthSessionService({
      browser: { open: () => Promise.resolve(false) },
      clock: fixedClock(TEST_NOW),
      credentialKey: TEST_KEY,
      credentialStore: credentials,
      endpoints: authEndpointsFromIssuer('https://api.example.test', {
        authorizationEndpoint: 'https://web.example.test/authorize',
      }),
      entropy: new CountingEntropy(),
      listenerFactory: startLoopbackListener,
      loginTimeoutMilliseconds: 5_000,
      metadataStore: metadata,
      oauth: () => ({
        exchangeAuthorizationCode: () => Promise.resolve(tokenPair('b')),
        refresh: () => Promise.resolve(tokenPair('b')),
        revoke: () => Promise.resolve(),
      }),
    })

    await expect(
      service.login({
        openBrowser: false,
        onAuthorizationUrl: (url) => {
          const redirectUri = new URL(url).searchParams.get('redirect_uri') ?? ''
          const state = new URL(url).searchParams.get('state') ?? ''
          setTimeout(() => void sendCallback(redirectUri, CODE, state), 10)
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(credentials.values.size).toBe(1)
    expect(metadata.value).toBeNull()
  })

  it('surfaces a typed failure and still clears everything when local cleanup fails on logout', async () => {
    const credentials = new FailingDeleteCredentialStore()
    credentials.failDeletes = true
    const metadata = new MemoryMetadataRepository()
    await credentials.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    metadata.value = AuthMetadataSchema.parse({
      audience: 'cli',
      clientId: 'ocb_cli',
      expiresAt: new Date(TEST_NOW + 900_000).toISOString(),
      identity: TEST_KEY,
      issuer: 'https://api.example.test',
      schemaVersion: 1,
      scopes: ['source:read'],
      updatedAt: new Date(TEST_NOW).toISOString(),
    })
    const service = new AuthSessionService({
      browser: { open: () => Promise.resolve(true) },
      clock: fixedClock(TEST_NOW),
      credentialKey: TEST_KEY,
      credentialStore: credentials,
      endpoints: null,
      entropy: new CountingEntropy(),
      listenerFactory: startLoopbackListener,
      loginTimeoutMilliseconds: 5_000,
      metadataStore: metadata,
      oauth: () => ({
        exchangeAuthorizationCode: () => Promise.resolve(tokenPair('b')),
        refresh: () => Promise.resolve(tokenPair('b')),
        revoke: () => Promise.resolve(),
      }),
    })
    // The error is typed; no false "logged_out" result reaches the caller.
    await expect(service.logout()).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('rejects a cancelled login with auth-required and stops the listener', async () => {
    const h = harness()
    const controller = new AbortController()
    controller.abort()
    await expect(
      h.service.login({ openBrowser: false, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(h.credentials.sets).toHaveLength(0)
  })
})

describe('auth session gate wiring', () => {
  it('closes the loopback listener when reading prior state fails after the bind', async () => {
    const credentials = new MemoryCredentialStore()
    const metadata = new MemoryMetadataRepository()
    let credentialReads = 0
    const proxy: MemoryCredentialStore = new Proxy(credentials, {
      get(target, property, receiver) {
        if (property === 'get') {
          return (key: HostedOAuthCredentialKey) => {
            credentialReads += 1
            if (credentialReads === 1) return Promise.reject(new Error('state read failed'))
            return Reflect.get(target, property, receiver).call(target, key)
          }
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const service = new AuthSessionService({
      browser: { open: () => Promise.resolve(false) },
      clock: fixedClock(TEST_NOW),
      credentialKey: TEST_KEY,
      credentialStore: proxy,
      endpoints: authEndpointsFromIssuer('https://api.example.test', {
        authorizationEndpoint: 'https://web.example.test/authorize',
      }),
      entropy: new CountingEntropy(),
      listenerFactory: startLoopbackListener,
      loginTimeoutMilliseconds: 5_000,
      metadataStore: metadata,
      oauth: () => ({
        exchangeAuthorizationCode: () => Promise.resolve(tokenPair('b')),
        refresh: () => Promise.resolve(tokenPair('b')),
        revoke: () => Promise.resolve(),
      }),
    })
    await expect(
      service.login({
        openBrowser: false,
        onAuthorizationUrl: (url) => {
          const redirectUri = new URL(url).searchParams.get('redirect_uri') ?? ''
          const state = new URL(url).searchParams.get('state') ?? ''
          setTimeout(() => void sendCallback(redirectUri, CODE, state), 10)
        },
      }),
    ).rejects.toMatchObject({ message: 'state read failed' })
    // No commit happened despite the code being exchanged.
    expect(credentials.sets).toHaveLength(0)
    expect(metadata.value).toBeNull()
  })

  it('serializes session sections through the gate without overlap', async () => {
    const gate = concurrencyTrackingGate()
    const h = harness()
    await h.credentials.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    h.metadata.value = AuthMetadataSchema.parse({
      audience: 'cli',
      clientId: 'ocb_cli',
      expiresAt: new Date(TEST_NOW + 900_000).toISOString(),
      identity: TEST_KEY,
      issuer: 'https://api.example.test',
      schemaVersion: 1,
      scopes: ['source:read'],
      updatedAt: new Date(TEST_NOW).toISOString(),
    })
    const service = new AuthSessionService({
      browser: { open: () => Promise.resolve(false) },
      clock: fixedClock(TEST_NOW),
      credentialKey: TEST_KEY,
      credentialStore: h.credentials,
      endpoints: null,
      entropy: new CountingEntropy(),
      listenerFactory: startLoopbackListener,
      loginTimeoutMilliseconds: 5_000,
      metadataStore: h.metadata,
      sessionGate: gate,
      oauth: () => ({
        exchangeAuthorizationCode: () => Promise.resolve(tokenPair('b')),
        refresh: () => Promise.resolve(tokenPair('b')),
        revoke: () => Promise.resolve(),
      }),
    })
    const overlapping = [service.status(), service.logout(), service.status()]
    await Promise.all(overlapping)
    expect(gate.maxConcurrent()).toBe(1)
  })

  it('surfaces gate contention as a typed conflict on logout', async () => {
    const h = harness()
    const service = new AuthSessionService({
      browser: { open: () => Promise.resolve(false) },
      clock: fixedClock(TEST_NOW),
      credentialKey: TEST_KEY,
      credentialStore: h.credentials,
      endpoints: null,
      entropy: new CountingEntropy(),
      listenerFactory: startLoopbackListener,
      loginTimeoutMilliseconds: 5_000,
      metadataStore: h.metadata,
      sessionGate: failingGate(
        new OcboxError({ code: 'OPERATION_CONFLICT', message: 'busy', requestId: newRequestId() }),
      ),
      oauth: () => ({
        exchangeAuthorizationCode: () => Promise.resolve(tokenPair('b')),
        refresh: () => Promise.resolve(tokenPair('b')),
        revoke: () => Promise.resolve(),
      }),
    })
    await expect(service.logout()).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
    // No local material was touched by the failed, gated logout.
    expect(h.credentials.values.size).toBe(0)
    expect(h.metadata.value).toBeNull()
  })

  it('reports a truthful typed failure when status cannot clear stale metadata', async () => {
    const credentials = new MemoryCredentialStore()
    class FailingClearMetadataRepository extends MemoryMetadataRepository {
      override clear(): Promise<void> {
        return Promise.reject(new Error('disk failure'))
      }
    }
    const metadata = new FailingClearMetadataRepository()
    metadata.value = AuthMetadataSchema.parse({
      audience: 'cli',
      clientId: 'ocb_cli',
      expiresAt: new Date(TEST_NOW + 900_000).toISOString(),
      identity: TEST_KEY,
      issuer: 'https://api.example.test',
      schemaVersion: 1,
      scopes: ['source:read'],
      updatedAt: new Date(TEST_NOW).toISOString(),
    })
    const service = new AuthSessionService({
      browser: { open: () => Promise.resolve(false) },
      clock: fixedClock(TEST_NOW),
      credentialKey: TEST_KEY,
      credentialStore: credentials,
      endpoints: null,
      entropy: new CountingEntropy(),
      listenerFactory: startLoopbackListener,
      loginTimeoutMilliseconds: 5_000,
      metadataStore: metadata,
      oauth: () => ({
        exchangeAuthorizationCode: () => Promise.resolve(tokenPair('b')),
        refresh: () => Promise.resolve(tokenPair('b')),
        revoke: () => Promise.resolve(),
      }),
    })
    // The stale metadata cannot be cleared, so the failure must be typed and
    // truthful: no false logged-out status while stale state remains.
    await expect(service.status()).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(metadata.value).not.toBeNull()
  })

  it('does not revoke or delete a credential generation it did not read', async () => {
    const credentials = new MemoryCredentialStore()
    const metadata = new MemoryMetadataRepository()
    const gate = concurrencyTrackingGate()
    const generationOne = credentialFromTokenPair(tokenPair('a'), TEST_NOW)
    const generationTwo = credentialFromTokenPair(tokenPair('b'), TEST_NOW)
    await credentials.set(TEST_KEY, generationOne)
    metadata.value = AuthMetadataSchema.parse({
      audience: 'cli',
      clientId: 'ocb_cli',
      expiresAt: new Date(TEST_NOW + 900_000).toISOString(),
      identity: TEST_KEY,
      issuer: 'https://api.example.test',
      schemaVersion: 1,
      scopes: ['source:read'],
      updatedAt: new Date(TEST_NOW).toISOString(),
    })
    const revokeCalls: Array<{ token: string }> = []
    let writer: Promise<void> | null = null
    const oauthPort = {
      exchangeAuthorizationCode: () => Promise.resolve(tokenPair('b')),
      refresh: () => Promise.resolve(tokenPair('b')),
      revoke: async (input: { token: string }) => {
        revokeCalls.push({ token: input.token })
        // A gate-respecting login/refresh queues its whole state generation
        // while logout still holds the shared outer lock.
        writer = gate(async () => {
          await credentials.set(TEST_KEY, generationTwo)
          metadata.value = AuthMetadataSchema.parse({
            audience: 'cli',
            clientId: 'ocb_cli',
            expiresAt: generationTwo.expiresAt,
            identity: TEST_KEY,
            issuer: 'https://api.example.test',
            schemaVersion: 1,
            scopes: generationTwo.scopes,
            updatedAt: new Date(TEST_NOW + 1).toISOString(),
          })
        })
      },
    }
    const service = new AuthSessionService({
      browser: { open: () => Promise.resolve(false) },
      clock: fixedClock(TEST_NOW),
      credentialKey: TEST_KEY,
      credentialStore: credentials,
      endpoints: authEndpointsFromIssuer('https://api.example.test', {
        authorizationEndpoint: 'https://web.example.test/authorize',
      }),
      entropy: new CountingEntropy(),
      listenerFactory: startLoopbackListener,
      loginTimeoutMilliseconds: 5_000,
      metadataStore: metadata,
      sessionGate: gate,
      oauth: () => oauthPort,
    })
    const result = await service.logout()
    await writer
    // Revocation and cleanup targeted generation one. The queued writer then
    // committed generation two after logout released the shared lock.
    expect(result.revoked).toBe(true)
    expect(revokeCalls).toEqual([{ token: 'A'.repeat(48) }])
    expect(revokeCalls).toHaveLength(1)
    await expect(credentials.get(TEST_KEY)).resolves.toMatchObject({
      accessToken: 'b'.repeat(48),
    })
    expect(metadata.value?.updatedAt).toBe(new Date(TEST_NOW + 1).toISOString())
  })

  it('preserves local cleanup even when revocation fails mid-logout', async () => {
    const credentials = new MemoryCredentialStore()
    const metadata = new MemoryMetadataRepository()
    await credentials.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    metadata.value = AuthMetadataSchema.parse({
      audience: 'cli',
      clientId: 'ocb_cli',
      expiresAt: new Date(TEST_NOW + 900_000).toISOString(),
      identity: TEST_KEY,
      issuer: 'https://api.example.test',
      schemaVersion: 1,
      scopes: ['source:read'],
      updatedAt: new Date(TEST_NOW).toISOString(),
    })
    const service = new AuthSessionService({
      browser: { open: () => Promise.resolve(false) },
      clock: fixedClock(TEST_NOW),
      credentialKey: TEST_KEY,
      credentialStore: credentials,
      endpoints: authEndpointsFromIssuer('https://api.example.test', {
        authorizationEndpoint: 'https://web.example.test/authorize',
      }),
      entropy: new CountingEntropy(),
      listenerFactory: startLoopbackListener,
      loginTimeoutMilliseconds: 5_000,
      metadataStore: metadata,
      oauth: () => ({
        exchangeAuthorizationCode: () => Promise.resolve(tokenPair('b')),
        refresh: () => Promise.resolve(tokenPair('b')),
        revoke: () => Promise.reject(new Error('server down')),
      }),
    })
    const result = await service.logout()
    expect(result).toEqual({ loggedOut: true, revocationAttempted: true, revoked: false })
    expect(credentials.values.size).toBe(0)
    expect(metadata.value).toBeNull()
  })
})

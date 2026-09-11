import { describe, expect, it, vi } from 'vitest'
import { AuthBindingError, LoginRequiredError } from '../../src/auth/errors.js'
import { AuthMetadataSchema } from '../../src/auth/metadata.js'
import { credentialFromTokenPair, HostedTokenManager } from '../../src/auth/token-manager.js'
import {
  deferred,
  fixedClock,
  MemoryCredentialStore,
  MemoryMetadataRepository,
  TEST_KEY,
  TEST_NOW,
  tokenPair,
} from './doubles.js'

describe('hosted token manager', () => {
  it('refreshes only when the credential is inside the expiry skew', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a', 60), TEST_NOW))
    const refresh = vi.fn(() => Promise.resolve(tokenPair('b')))
    const manager = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh,
      store,
    })

    const valid = await manager.getValidCredential()
    expect(valid.accessToken).toBe('a'.repeat(48))
    expect(refresh).not.toHaveBeenCalled()

    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a', 10), TEST_NOW))
    const refreshed = await manager.getValidCredential()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refreshed.accessToken).toBe('b'.repeat(48))
  })

  it('serializes one refresh across concurrent readers', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a', 10), TEST_NOW))
    const pending = deferred<import('../../src/auth/oauth-client.js').CliTokenPair>()
    const refresh = vi.fn(() => pending.promise)
    const manager = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh,
      store,
    })

    const first = manager.getValidCredential()
    const second = manager.getValidCredential()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(refresh).toHaveBeenCalledTimes(1)
    pending.resolve(tokenPair('b'))
    await expect(first).resolves.toMatchObject({ accessToken: 'b'.repeat(48) })
    await expect(second).resolves.toMatchObject({ accessToken: 'b'.repeat(48) })
    expect(store.values.size).toBe(1)
  })

  it('clears material and reports login-required on refresh reuse or revocation', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a', 10), TEST_NOW))
    const manager = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh: () => Promise.reject(new LoginRequiredError()),
      store,
    })

    await expect(manager.getValidCredential()).rejects.toBeInstanceOf(LoginRequiredError)
    expect(store.values.size).toBe(0)
  })

  it('enforces audience/scope binding before use', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    const manager = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh: () => Promise.resolve(tokenPair('b')),
      requiredScopes: ['sandboxes:write'],
      store,
    })
    await expect(manager.getValidCredential()).rejects.toBeInstanceOf(AuthBindingError)
  })

  it('refuses credentials not attested by matching issuer metadata or with no metadata', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    const metadata = new MemoryMetadataRepository()
    const managerFor = (issuer: string) =>
      new HostedTokenManager({
        clock: fixedClock(TEST_NOW),
        expirySkewMilliseconds: 30_000,
        key: TEST_KEY,
        refresh: () => Promise.resolve(tokenPair('b')),
        store,
        binding: { expectedIssuer: issuer, metadataRepository: metadata },
      })

    // No metadata: an unbound credential from an unknown origin is refused.
    await expect(managerFor('https://api.test').getValidCredential()).rejects.toBeInstanceOf(
      AuthBindingError,
    )
    // A credential minted by staging cannot be replayed against production.
    metadata.value = AuthMetadataSchema.parse({
      audience: 'cli',
      clientId: 'ocb_cli',
      expiresAt: new Date(TEST_NOW + 900_000).toISOString(),
      identity: TEST_KEY,
      issuer: 'https://staging.test',
      schemaVersion: 1,
      scopes: ['source:read'],
      updatedAt: new Date(TEST_NOW).toISOString(),
    })
    await expect(managerFor('https://api.test').getValidCredential()).rejects.toBeInstanceOf(
      AuthBindingError,
    )
    expect(store.values.size).toBe(1)
    const matched = managerFor('https://staging.test')
    metadata.value.scopes = ['source:read']
    metadata.value.audience = 'cli'
    await expect(matched.getValidCredential()).resolves.toMatchObject({
      accessToken: 'a'.repeat(48),
    })
  })

  it('serializes refresh across separate manager instances through the shared gate, never presenting a reused refresh token', async () => {
    // Server-side single-use family semantics: two calls presenting the same
    // already-supersede refresh token are reuse — the second revokes everything.
    const sharedStore = new MemoryCredentialStore()
    await sharedStore.set(TEST_KEY, credentialFromTokenPair(tokenPair('a', 10), TEST_NOW))
    const presented = new Set<string>()
    let reuseStruck = 0
    const refreshAgainstServer = vi.fn(async ({ refreshToken }: { refreshToken: string }) => {
      if (presented.has(refreshToken)) {
        reuseStruck += 1
        throw new LoginRequiredError()
      }
      presented.add(refreshToken)
      return tokenPair(refreshToken === 'A'.repeat(48) ? 'b' : 'c')
    })
    // A faithful (serializing) stand-in for the file-lock coordinator shared by
    // both "processes".
    let chain: Promise<unknown> = Promise.resolve()
    const stats = { value: 0, active: 0 }
    const use = async <R>(action: () => Promise<R>): Promise<R> => {
      const previous = chain
      let release!: () => void
      chain = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      stats.active += 1
      stats.value = Math.max(stats.value, stats.active)
      try {
        return await action()
      } finally {
        stats.active -= 1
        release()
      }
    }
    const buildManager = () =>
      new HostedTokenManager({
        clock: fixedClock(TEST_NOW),
        expirySkewMilliseconds: 30_000,
        key: TEST_KEY,
        refresh: refreshAgainstServer,
        refreshGate: use,
        store: sharedStore,
      })
    const managerA = buildManager()
    const managerB = buildManager()

    const firstPromise = managerA.refresh()
    const secondPromise = managerB.refresh()
    // With the shared gate, the sibling re-reads inside the critical section and
    // presents the *rotated* token, so no reuse ever reaches the server.
    await expect(firstPromise).resolves.toMatchObject({ accessToken: 'b'.repeat(48) })
    await expect(secondPromise).resolves.toMatchObject({ accessToken: 'c'.repeat(48) })
    expect(refreshAgainstServer).toHaveBeenCalledTimes(2)
    expect(reuseStruck).toBe(0)
    expect(stats.value).toBe(1)
  })

  it('does not delete newer credential material when refresh reuse fails after a concurrent rotation', async () => {
    const store = new MemoryCredentialStore()
    const oldCredential = credentialFromTokenPair(tokenPair('a', 10), TEST_NOW)
    await store.set(TEST_KEY, oldCredential)
    const rotated = credentialFromTokenPair(tokenPair('b'), TEST_NOW)
    const manager = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      // Meanwhile another process has rotated and stored its generation.
      refresh: async () => {
        await store.set(TEST_KEY, rotated)
        throw new LoginRequiredError()
      },
      store,
    })
    await expect(manager.getValidCredential()).rejects.toBeInstanceOf(LoginRequiredError)
    // The concurrent writer's material survives the snapshot-based clear.
    await expect(store.get(TEST_KEY)).resolves.toMatchObject({ accessToken: 'b'.repeat(48) })
  })

  it('clearIfToken and clearIfCredential refuse snapshots replaced by a concurrent writer', async () => {
    const store = new MemoryCredentialStore()
    const initial = credentialFromTokenPair(tokenPair('a'), TEST_NOW)
    await store.set(TEST_KEY, initial)
    const manager = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh: () => Promise.resolve(tokenPair('b')),
      store,
    })
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('z'), TEST_NOW))
    await expect(manager.clearIfToken('a'.repeat(48))).resolves.toBe(false)
    await expect(manager.clearIfCredential(initial)).resolves.toBe(false)
    await expect(store.get(TEST_KEY)).resolves.toMatchObject({ accessToken: 'z'.repeat(48) })
    await expect(
      manager.clearIfCredential(credentialFromTokenPair(tokenPair('z'), TEST_NOW)),
    ).resolves.toBe(true)
    await expect(store.get(TEST_KEY)).resolves.toBeNull()
  })
})

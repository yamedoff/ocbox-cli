import { describe, expect, it, vi } from 'vitest'
import { AuthBindingError, LoginRequiredError } from '../../src/auth/errors.js'
import { credentialFromTokenPair, HostedTokenManager } from '../../src/auth/token-manager.js'
import {
  deferred,
  fixedClock,
  MemoryCredentialStore,
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
})

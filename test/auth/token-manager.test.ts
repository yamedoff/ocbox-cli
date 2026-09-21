import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthBindingError, LoginRequiredError, newRequestId } from '../../src/auth/errors.js'
import { type AuthMetadata, AuthMetadataSchema } from '../../src/auth/metadata.js'
import { createRefreshGate } from '../../src/auth/runtime.js'
import {
  credentialFromTokenPair,
  HostedTokenManager,
  type TokenRefreshInput,
} from '../../src/auth/token-manager.js'
import {
  type HostedOAuthCredential,
  type HostedOAuthCredentialKey,
  ProtectedFileCredentialStore,
  type WindowsAclProtector,
} from '../../src/credentials/index.js'
import { OcboxError } from '../../src/errors/index.js'
import {
  deferred,
  fixedClock,
  MemoryCredentialStore,
  MemoryMetadataRepository,
  TEST_KEY,
  TEST_NOW,
  tokenPair,
} from './doubles.js'

const directories: string[] = []
async function temporaryStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ocbox-auth-gate-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

/** Per-operation hooks so tests can hold the store mid-operation deterministically. */
class HookedCredentialStore extends MemoryCredentialStore {
  onGet: (() => Promise<void>) | null = null
  onSet: (() => Promise<void>) | null = null
  onDelete: (() => Promise<void>) | null = null

  override async get(key: HostedOAuthCredentialKey): Promise<HostedOAuthCredential | null> {
    const credential = await super.get(key)
    if (this.onGet !== null) await this.onGet()
    return credential
  }

  override async set(
    key: HostedOAuthCredentialKey,
    credential: HostedOAuthCredential,
  ): Promise<void> {
    if (this.onSet !== null) await this.onSet()
    await super.set(key, credential)
  }

  override async delete(key: HostedOAuthCredentialKey): Promise<void> {
    if (this.onDelete !== null) await this.onDelete()
    await super.delete(key)
  }
}

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

  it('lets a coalesced caller cancel its wait without cancelling the shared refresh', async () => {
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
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    const controller = new AbortController()
    const cancelled = manager.getValidCredential(controller.signal)
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })

    pending.resolve(tokenPair('b'))
    await expect(first).resolves.toMatchObject({ accessToken: 'b'.repeat(48) })
    await expect(store.get(TEST_KEY)).resolves.toMatchObject({ accessToken: 'b'.repeat(48) })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('retries for a live waiter when only the refresh initiator is cancelled', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a', 10), TEST_NOW))
    let callCount = 0
    const refresh = vi.fn(({ signal }: TokenRefreshInput) => {
      callCount += 1
      if (callCount > 1) return Promise.resolve(tokenPair('b'))
      return new Promise<ReturnType<typeof tokenPair>>((_resolve, reject) => {
        const cancel = (): void =>
          reject(
            new OcboxError({
              code: 'OPERATION_CANCELLED',
              message: 'cancelled',
              requestId: newRequestId(),
            }),
          )
        if (signal?.aborted === true) cancel()
        else signal?.addEventListener('abort', cancel, { once: true })
      })
    })
    const manager = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh,
      store,
    })

    const initiator = new AbortController()
    const cancelled = manager.getValidCredential(initiator.signal)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    const liveWaiter = manager.getValidCredential()
    initiator.abort()

    await expect(cancelled).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    await expect(liveWaiter).resolves.toMatchObject({ accessToken: 'b'.repeat(48) })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('keeps the local refresh chain intact when a queued forced caller cancels', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a', 10), TEST_NOW))
    const pending = deferred<import('../../src/auth/oauth-client.js').CliTokenPair>()
    const refresh = vi
      .fn<() => Promise<import('../../src/auth/oauth-client.js').CliTokenPair>>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(tokenPair('c'))
    const manager = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh,
      store,
    })

    const first = manager.getValidCredential()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    const controller = new AbortController()
    const queued = manager.refresh({
      rejectedAccessToken: 'a'.repeat(48),
      signal: controller.signal,
    })
    controller.abort()
    await expect(queued).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })

    const later = manager.getValidCredential()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(refresh).toHaveBeenCalledTimes(1)
    pending.resolve(tokenPair('b'))

    await expect(first).resolves.toMatchObject({ accessToken: 'b'.repeat(48) })
    await expect(later).resolves.toMatchObject({ accessToken: 'b'.repeat(48) })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('adopts a fresh stored generation instead of rotating a second time', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a', 10), TEST_NOW))
    const refresh = vi.fn(() => Promise.resolve(tokenPair('b')))
    const manager = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh,
      store,
    })

    // A concurrent actor rotated while this caller was waiting to refresh.
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('z'), TEST_NOW))
    await expect(manager.refresh()).resolves.toMatchObject({ accessToken: 'z'.repeat(48) })
    expect(refresh).not.toHaveBeenCalled()
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
        binding: {
          expectedClientId: 'ocb_cli',
          expectedIssuer: issuer,
          metadataRepository: metadata,
        },
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

  it('binds client id, credential identity, and metadata scopes, refusing stale metadata', async () => {
    const store = new MemoryCredentialStore()
    const metadata = new MemoryMetadataRepository()
    const saveMetadata = async (overrides: Partial<AuthMetadata> = {}) => {
      metadata.value = AuthMetadataSchema.parse({
        audience: 'cli',
        clientId: 'ocb_cli',
        expiresAt: new Date(TEST_NOW + 900_000).toISOString(),
        identity: TEST_KEY,
        issuer: 'https://api.test',
        schemaVersion: 1,
        scopes: ['source:read'],
        updatedAt: new Date(TEST_NOW).toISOString(),
        ...overrides,
      })
    }
    const managerFor = (clientId = 'ocb_cli', requiredScopes?: readonly string[]) =>
      new HostedTokenManager({
        clock: fixedClock(TEST_NOW),
        expirySkewMilliseconds: 30_000,
        key: TEST_KEY,
        refresh: () => Promise.resolve(tokenPair('b')),
        ...(requiredScopes === undefined ? {} : { requiredScopes }),
        store,
        binding: {
          expectedClientId: clientId,
          expectedIssuer: 'https://api.test',
          metadataRepository: metadata,
        },
      })

    await saveMetadata()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    await expect(managerFor().getValidCredential()).resolves.toMatchObject({
      accessToken: 'a'.repeat(48),
    })

    // Metadata minted for another OAuth client cannot vouch for this one.
    await expect(managerFor('other_client').getValidCredential()).rejects.toBeInstanceOf(
      AuthBindingError,
    )
    // Metadata pointing at a different credential identity does not attest ours.
    await saveMetadata({
      identity: { accountId: 'other', kind: 'hosted-oauth', provider: 'ocbox' },
    })
    await expect(managerFor().getValidCredential()).rejects.toBeInstanceOf(AuthBindingError)
    await saveMetadata()

    // The credential carries the scope, but stale metadata does not attest it.
    await store.set(TEST_KEY, {
      ...credentialFromTokenPair(tokenPair('a'), TEST_NOW),
      scopes: ['source:read', 'sandboxes:write'],
    })
    await expect(
      managerFor('ocb_cli', ['sandboxes:write']).getValidCredential(),
    ).rejects.toBeInstanceOf(AuthBindingError)
    await saveMetadata({ scopes: ['source:read', 'sandboxes:write'] })
    await expect(
      managerFor('ocb_cli', ['sandboxes:write']).getValidCredential(),
    ).resolves.toMatchObject({ accessToken: 'a'.repeat(48) })

    // Required-scope containment is insufficient: metadata and the stored
    // token must describe exactly one grant generation.
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    await expect(
      managerFor('ocb_cli', ['source:read']).getValidCredential(),
    ).rejects.toBeInstanceOf(AuthBindingError)
    expect(store.values.size).toBe(1)
  })

  it('a second manager adopting through the shared gate never presents a reused refresh token', async () => {
    // Server-side single-use family semantics: two calls presenting the same
    // already-superseded refresh token are reuse — the second revokes everything.
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
    let active = 0
    let maxActive = 0
    const use = async <R>(action: () => Promise<R>): Promise<R> => {
      const previous = chain
      let release!: () => void
      chain = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        return await action()
      } finally {
        active -= 1
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
    // The sibling re-reads inside the critical section and adopts the rotated
    // generation instead of presenting the same refresh token again.
    await expect(firstPromise).resolves.toMatchObject({ accessToken: 'b'.repeat(48) })
    await expect(secondPromise).resolves.toMatchObject({ accessToken: 'b'.repeat(48) })
    expect(refreshAgainstServer).toHaveBeenCalledTimes(1)
    expect(reuseStruck).toBe(0)
    expect(maxActive).toBe(1)
  })

  it('a 401-triggered refresh forces rotation only while acting on the current access token', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a', 10), TEST_NOW))
    const refresh = vi.fn(() => Promise.resolve(tokenPair('c')))
    const manager = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh,
      store,
    })

    // Another process already rotated away from the rejected token: adopt its
    // generation instead of burning the current family.
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('b'), TEST_NOW))
    await expect(manager.refresh({ rejectedAccessToken: 'a'.repeat(48) })).resolves.toMatchObject({
      accessToken: 'b'.repeat(48),
    })
    expect(refresh).not.toHaveBeenCalled()

    // The rejected token is still the stored one: rotation is forced even
    // though the credential is not yet time-expiring.
    await expect(manager.refresh({ rejectedAccessToken: 'b'.repeat(48) })).resolves.toMatchObject({
      accessToken: 'c'.repeat(48),
    })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('forwards the caller signal to the refresh gate', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a', 10), TEST_NOW))
    const observed: Array<AbortSignal | undefined> = []
    const controller = new AbortController()
    const manager = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh: () => Promise.resolve(tokenPair('b')),
      refreshGate: (action, signal) => {
        observed.push(signal)
        return action()
      },
      store,
    })

    await manager.refresh({ signal: controller.signal })
    expect(observed).toEqual([controller.signal])
  })

  it('does not start a credential read or rotation for an already-cancelled caller', async () => {
    const store = new HookedCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a', 10), TEST_NOW))
    let reads = 0
    store.onGet = () => {
      reads += 1
      return Promise.resolve()
    }
    const refresh = vi.fn(() => Promise.resolve(tokenPair('b')))
    const manager = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh,
      store,
    })
    const controller = new AbortController()
    controller.abort()

    await expect(manager.getValidCredential(controller.signal)).rejects.toMatchObject({
      code: 'OPERATION_CANCELLED',
    })
    expect(reads).toBe(0)
    expect(refresh).not.toHaveBeenCalled()
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

  it('coordinates two independent managers and file-backed stores through the real exclusive file lock', async () => {
    const stateDirectory = await temporaryStateDirectory()
    const credentialDirectory = join(stateDirectory, 'credentials')
    // Permission hardening is covered by the credential-store tests; the lock
    // coordination under audit here only needs real shared file state.
    const aclStub: WindowsAclProtector = { protectAndVerify: () => Promise.resolve(true) }
    const presented: string[] = []
    const refreshAgainstServer = vi.fn(async ({ refreshToken }: { refreshToken: string }) => {
      presented.push(refreshToken)
      return tokenPair(refreshToken === 'A'.repeat(48) ? 'b' : 'c')
    })
    const buildManager = () =>
      new HostedTokenManager({
        clock: fixedClock(TEST_NOW),
        expirySkewMilliseconds: 30_000,
        key: TEST_KEY,
        refresh: refreshAgainstServer,
        refreshGate: createRefreshGate(stateDirectory),
        store: new ProtectedFileCredentialStore(credentialDirectory, {
          windowsAclProtector: aclStub,
        }),
      })
    const seedStore = new ProtectedFileCredentialStore(credentialDirectory, {
      windowsAclProtector: aclStub,
    })
    await seedStore.set(TEST_KEY, credentialFromTokenPair(tokenPair('a', 10), TEST_NOW))

    const [first, second] = await Promise.all([buildManager().refresh(), buildManager().refresh()])
    // Exactly one process rotated; the loser observed the real file lock,
    // re-read the rotated generation inside the gate, and adopted it.
    expect(presented).toEqual(['A'.repeat(48)])
    expect(first.accessToken).toBe('b'.repeat(48))
    expect(second.accessToken).toBe('b'.repeat(48))
    await expect(buildManager().read()).resolves.toMatchObject({ accessToken: 'b'.repeat(48) })
  })

  it('holds the real refresh gate across compare-and-delete so a concurrent rotation is never destroyed', async () => {
    const stateDirectory = await temporaryStateDirectory()
    const store = new HookedCredentialStore()
    const initial = credentialFromTokenPair(tokenPair('a'), TEST_NOW)
    await store.set(TEST_KEY, initial)
    const manager = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh: () => Promise.resolve(tokenPair('b')),
      refreshGate: createRefreshGate(stateDirectory),
      store,
    })
    const operations: string[] = []
    const blockedGet = deferred<void>()
    store.onGet = async () => {
      operations.push('get')
      await blockedGet.promise
    }
    store.onDelete = async () => {
      operations.push('delete')
    }
    store.onSet = async () => {
      operations.push('set')
    }

    // The compare-and-delete acquires the real state-directory lock and blocks
    // inside its read, holding the critical section open.
    const clearPromise = manager.clearIfCredential(initial)
    await vi.waitFor(() => expect(operations).toContain('get'))

    // A gate-respecting writer (a second "process") must stay blocked for the
    // whole section; it can never slip between the comparison and the delete.
    const writer = createRefreshGate(stateDirectory)(async () => {
      operations.push('writer:set')
      await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('z'), TEST_NOW))
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(operations).not.toContain('writer:set')

    blockedGet.resolve()
    await expect(clearPromise).resolves.toBe(true)
    await writer
    expect(operations.indexOf('delete')).toBeLessThan(operations.indexOf('writer:set'))
    // The concurrent writer's material survives; only the matched snapshot was
    // deleted.
    await expect(store.get(TEST_KEY)).resolves.toMatchObject({ accessToken: 'z'.repeat(48) })
  })
})

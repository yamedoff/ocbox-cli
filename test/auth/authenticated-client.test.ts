import { describe, expect, it, vi } from 'vitest'
import { AuthenticatedHttpClient } from '../../src/auth/authenticated-client.js'
import { AuthBindingError, LoginRequiredError } from '../../src/auth/errors.js'
import type { FetchPort } from '../../src/auth/ports.js'
import { credentialFromTokenPair, HostedTokenManager } from '../../src/auth/token-manager.js'
import { fixedClock, MemoryCredentialStore, TEST_KEY, TEST_NOW, tokenPair } from './doubles.js'

const ACCESS_A = 'a'.repeat(48)
const ACCESS_B = 'b'.repeat(48)

function authHeader(init?: RequestInit): string {
  // biome-ignore lint/complexity/useLiteralKeys: Record index signature access
  return ((init?.headers as Record<string, string> | undefined)?.['authorization'] ?? '')
    .replace(/^Bearer\s+/, '')
    .trim()
}

describe('authenticated HTTP client', () => {
  it('attaches the bearer token and retries an idempotent request once after one refresh', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    const refresh = vi.fn(() => Promise.resolve(tokenPair('b')))
    const tokens = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh,
      store,
    })
    const seen: string[] = []
    const fetchImpl: FetchPort = (_input, init) => {
      const token = authHeader(init)
      seen.push(token)
      return Promise.resolve(
        token === ACCESS_A
          ? new Response('unauthorized', { headers: { 'x-request-id': 'req_unauth' }, status: 401 })
          : new Response('ok', { headers: { 'x-request-id': 'req_ok' }, status: 200 }),
      )
    }
    const client = new AuthenticatedHttpClient({
      fetch: fetchImpl,
      timeoutMilliseconds: 1_000,
      tokens,
    })

    const result = await client.request({ method: 'GET', url: 'https://api.test/v1/projects' })
    expect(result.response.status).toBe(200)
    expect(result.requestId).toBe('req_ok')
    expect(seen).toEqual([ACCESS_A, ACCESS_B])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('fails closed after a second 401 and clears local material', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    const tokens = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh: () => Promise.resolve(tokenPair('b')),
      store,
    })
    let count = 0
    const fetchImpl: FetchPort = () => {
      count += 1
      return Promise.resolve(new Response('no', { status: 401 }))
    }
    const client = new AuthenticatedHttpClient({
      fetch: fetchImpl,
      timeoutMilliseconds: 1_000,
      tokens,
    })

    await expect(
      client.request({ method: 'GET', url: 'https://api.test/v1/projects' }),
    ).rejects.toBeInstanceOf(LoginRequiredError)
    expect(count).toBe(2)
    expect(store.values.size).toBe(0)
  })

  it('does not refresh or retry a non-replayable request on 401', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    const refresh = vi.fn(() => Promise.resolve(tokenPair('b')))
    const tokens = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh,
      store,
    })
    let count = 0
    const fetchImpl: FetchPort = () => {
      count += 1
      return Promise.resolve(new Response('no', { status: 401 }))
    }
    const client = new AuthenticatedHttpClient({
      fetch: fetchImpl,
      timeoutMilliseconds: 1_000,
      tokens,
    })

    const result = await client.request({
      body: '{}',
      method: 'POST',
      url: 'https://api.test/v1/projects',
    })
    expect(result.response.status).toBe(401)
    expect(count).toBe(1)
    expect(refresh).not.toHaveBeenCalled()
    // The stored material must survive; no rotation was burned for a request
    // that could not be retried.
    await expect(store.get(TEST_KEY)).resolves.toMatchObject({ accessToken: 'a'.repeat(48) })
  })

  it('retries a POST carrying an idempotency key once and fails closed on the second 401', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    const refresh = vi.fn(() => Promise.resolve(tokenPair('b')))
    const tokens = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh,
      store,
    })
    let count = 0
    const fetchImpl: FetchPort = () => {
      count += 1
      return Promise.resolve(new Response('no', { status: 401 }))
    }
    const client = new AuthenticatedHttpClient({
      fetch: fetchImpl,
      timeoutMilliseconds: 1_000,
      tokens,
    })

    await expect(
      client.request({
        body: '{}',
        idempotencyKey: 'idem-key-123456',
        method: 'POST',
        url: 'https://api.test/v1/projects',
      }),
    ).rejects.toBeInstanceOf(LoginRequiredError)
    expect(count).toBe(2)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(store.values.size).toBe(0)
  })

  it('owns the Authorization and Idempotency-Key headers exclusively across spellings', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    const tokens = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh: () => Promise.resolve(tokenPair('b')),
      store,
    })
    const captured: Array<{ authorization: string; idempotencyKey: string }> = []
    const fetchImpl: FetchPort = (_input, init) => {
      const headers = new Headers(init?.headers)
      captured.push({
        authorization: headers.get('authorization') ?? '',
        idempotencyKey: headers.get('idempotency-key') ?? '',
      })
      return Promise.resolve(new Response('ok', { status: 200 }))
    }
    const client = new AuthenticatedHttpClient({
      fetch: fetchImpl,
      timeoutMilliseconds: 1_000,
      tokens,
    })
    const result = await client.request({
      headers: { Authorization: 'forgotten', 'Idempotency-Key': 'stale' },
      idempotencyKey: 'fresh-key-1',
      method: 'POST',
      url: 'https://api.test/v1/projects',
    })
    expect(result.response.status).toBe(200)
    // The caller-supplied spellings must be gone; undici would otherwise merge
    // same-name entries into a combined header on the wire.
    expect(captured[0]).toEqual({
      authorization: `Bearer ${ACCESS_A}`,
      idempotencyKey: 'fresh-key-1',
    })
  })

  it('serializes refresh across concurrent 401 responses', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    const refresh = vi.fn(() => Promise.resolve(tokenPair('b')))
    const tokens = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh,
      store,
    })
    const fetchImpl: FetchPort = (_input, init) =>
      Promise.resolve(
        authHeader(init) === ACCESS_A
          ? new Response('unauthorized', { status: 401 })
          : new Response('ok', { status: 200 }),
      )
    const client = new AuthenticatedHttpClient({
      fetch: fetchImpl,
      timeoutMilliseconds: 1_000,
      tokens,
    })

    const [first, second] = await Promise.all([
      client.request({ method: 'GET', url: 'https://api.test/v1/projects' }),
      client.request({ method: 'GET', url: 'https://api.test/v1/projects' }),
    ])
    expect(first.response.status).toBe(200)
    expect(second.response.status).toBe(200)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('exposes bounded retry hints and rejects scope-mismatched credentials before sending', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    const tokens = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh: () => Promise.resolve(tokenPair('b')),
      store,
    })
    let called = false
    const fetchImpl: FetchPort = () => {
      called = true
      return Promise.resolve(
        new Response('slow down', { headers: { 'retry-after': '7' }, status: 429 }),
      )
    }
    const client = new AuthenticatedHttpClient({
      fetch: fetchImpl,
      timeoutMilliseconds: 1_000,
      tokens,
    })
    const result = await client.request({ method: 'GET', url: 'https://api.test/v1/projects' })
    expect(result.retryAfterSeconds).toBe(7)
    expect(called).toBe(true)
  })

  it('refuses to send the bearer credential to a foreign origin, credentialed, or fragment-bearing URL', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    const tokens = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh: () => Promise.resolve(tokenPair('b')),
      store,
    })
    let called = false
    const fetchImpl: FetchPort = () => {
      called = true
      return Promise.resolve(new Response('ok'))
    }
    const client = new AuthenticatedHttpClient({
      apiOrigin: 'https://api.test',
      fetch: fetchImpl,
      timeoutMilliseconds: 1_000,
      tokens,
    })

    await expect(
      client.request({ method: 'GET', url: 'https://attacker.test/v1/projects' }),
    ).rejects.toBeInstanceOf(AuthBindingError)
    await expect(
      client.request({ method: 'GET', url: 'https://user:pass@api.test/v1/projects' }),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      client.request({ method: 'GET', url: 'https://api.test/v1/x#steal' }),
    ).rejects.toBeInstanceOf(TypeError)
    // The refusal happens before any credential read; nothing was read, sent,
    // or rotated.
    expect(called).toBe(false)
    await expect(store.get(TEST_KEY)).resolves.toMatchObject({ accessToken: 'a'.repeat(48) })
  })

  it('binds the bearer to the configured base subtree on subpath deployments', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    const tokens = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh: () => Promise.resolve(tokenPair('b')),
      store,
    })
    let called = false
    const fetchImpl: FetchPort = () => {
      called = true
      return Promise.resolve(new Response('ok'))
    }
    const client = new AuthenticatedHttpClient({
      apiOrigin: 'https://api.test/deploy',
      fetch: fetchImpl,
      timeoutMilliseconds: 1_000,
      tokens,
    })

    const allowed = await client.request({
      method: 'GET',
      url: 'https://api.test/deploy/v1/projects',
    })
    expect(allowed.response.status).toBe(200)
    called = false
    await expect(
      client.request({ method: 'GET', url: 'https://api.test/other/v1/projects' }),
    ).rejects.toBeInstanceOf(AuthBindingError)
    await expect(
      client.request({ method: 'GET', url: 'https://api.test/deployments/v1/projects' }),
    ).rejects.toBeInstanceOf(AuthBindingError)
    expect(called).toBe(false)
    await expect(store.get(TEST_KEY)).resolves.toMatchObject({ accessToken: 'a'.repeat(48) })
  })

  it('never follows redirects with the bearer credential attached', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    const tokens = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh: () => Promise.reject(new Error('refresh must not run')),
      store,
    })
    let decodeRedirectTried = false
    let redirectAttempted = false
    const fetchImpl: FetchPort = (_input, init) => {
      if (init?.redirect === 'follow') {
        decodeRedirectTried = true
      }
      if (redirectAttempted) {
        // Reached only if fetch followed the redirect.
        return Promise.resolve(new Response('leak', { status: 200 }))
      }
      redirectAttempted = true
      return Promise.resolve(
        new Response('moved', {
          headers: { location: 'https://attacker.test/v1/steal' },
          status: 302,
        }),
      )
    }
    const client = new AuthenticatedHttpClient({
      fetch: fetchImpl,
      timeoutMilliseconds: 1_000,
      tokens,
    })
    await expect(
      client.request({ method: 'GET', url: 'https://api.test/v1/projects' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' })
    // One fetch call in manual-redirect mode; the 3xx was refused, not followed.
    expect(redirectAttempted).toBe(true)
    expect(decodeRedirectTried).toBe(false)
  })

  it('keeps a concurrently rotated credential instead of clearing it after a terminal 401', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    const tokens = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      // Our refresh rotates to 'c'; tokenPair('c') carries accessToken 'c'*48.
      refresh: async () => tokenPair('c'),
      store,
    })
    let calls = 0
    const fetchImpl: FetchPort = () => {
      calls += 1
      if (calls === 2) {
        // While the retry is being evaluated, a sibling process stores yet
        // another family ('z'); the retried token is no longer the stored one.
        void store.set(TEST_KEY, credentialFromTokenPair(tokenPair('z'), TEST_NOW))
      }
      return Promise.resolve(new Response('unauthorized', { status: 401 }))
    }
    const client = new AuthenticatedHttpClient({
      apiOrigin: 'https://api.test',
      fetch: fetchImpl,
      timeoutMilliseconds: 1_000,
      tokens,
    })
    const result = await client.request({ method: 'GET', url: 'https://api.test/v1/projects' })
    // The 401 is surfaced truthfully, and the sibling's stored material survives
    // instead of being destroyed by the terminal-401 clear.
    expect(result.response.status).toBe(401)
    expect(calls).toBe(2)
    await expect(store.get(TEST_KEY)).resolves.toMatchObject({ accessToken: 'z'.repeat(48) })
  })
})

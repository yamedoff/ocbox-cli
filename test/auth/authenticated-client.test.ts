import { describe, expect, it, vi } from 'vitest'
import { AuthenticatedHttpClient } from '../../src/auth/authenticated-client.js'
import { LoginRequiredError } from '../../src/auth/errors.js'
import type { FetchPort } from '../../src/auth/ports.js'
import { credentialFromTokenPair, HostedTokenManager } from '../../src/auth/token-manager.js'
import { fixedClock, MemoryCredentialStore, TEST_KEY, TEST_NOW, tokenPair } from './doubles.js'

const ACCESS_A = 'a'.repeat(48)
const ACCESS_B = 'b'.repeat(48)

function authHeader(init?: RequestInit): string {
  return ((init?.headers as Record<string, string> | undefined)?.['authorization'] ?? '').replace(
    /^Bearer\s+/,
    '',
  )
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

  it('refreshes but does not retry a non-idempotent request', async () => {
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
      idempotencyKey: 'idem-key-123456',
      method: 'POST',
      url: 'https://api.test/v1/projects',
    })
    expect(result.response.status).toBe(401)
    expect(count).toBe(1)
    expect(refresh).toHaveBeenCalledTimes(1)
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
})

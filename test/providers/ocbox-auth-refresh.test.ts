import { describe, expect, it, vi } from 'vitest'
import { createHostedApiClient } from '../../src/auth/hosted-client.js'
import { protocolEndpointsFromIssuer } from '../../src/auth/config.js'
import { credentialFromTokenPair, HostedTokenManager } from '../../src/auth/token-manager.js'
import {
  MemoryCredentialStore,
  TEST_KEY,
  TEST_NOW,
  fixedClock,
  tokenPair,
} from '../auth/doubles.js'

const ACCESS_A = 'a'.repeat(48)
const ACCESS_B = 'b'.repeat(48)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'x-request-id': '11111111-1111-4111-8111-111111111111' },
    status,
  })
}

describe('hosted auth expiry and refresh races', () => {
  it('performs one serialized refresh and retries the idempotent request once', async () => {
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
    const client = createHostedApiClient({
      fetch: (_input, init) => {
        const token = (new Headers(init?.headers).get('authorization') ?? '').replace(
          /^Bearer\s+/,
          '',
        )
        seen.push(token)
        if (token === ACCESS_A)
          return Promise.resolve(new Response('unauthorized', { status: 401 }))
        return Promise.resolve(jsonResponse({ data: [] }))
      },
      protocol: protocolEndpointsFromIssuer('https://api.test'),
      tokens,
    })
    const result = await client.listProjects()
    expect(result.status).toBe(200)
    expect(seen).toEqual([ACCESS_A, ACCESS_B])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent expiries into a single refresh', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    let refreshes = 0
    const tokens = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      key: TEST_KEY,
      expirySkewMilliseconds: 30_000,
      refresh: () => {
        refreshes += 1
        return new Promise((resolve) => setTimeout(() => resolve(tokenPair('b')), 10))
      },
      store,
    })
    await Promise.all([
      tokens.getValidCredential(),
      tokens.getValidCredential(),
      tokens.getValidCredential(),
    ])
    expect(refreshes).toBeLessThanOrEqual(1)
  })

  it('clears local material on reuse and requires login without leaking tokens', async () => {
    const store = new MemoryCredentialStore()
    await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
    const { LoginRequiredError } = await import('../../src/auth/errors.js')
    const tokens = new HostedTokenManager({
      clock: fixedClock(TEST_NOW),
      expirySkewMilliseconds: 30_000,
      key: TEST_KEY,
      refresh: () => Promise.reject(new LoginRequiredError()),
      store,
    })
    const client = createHostedApiClient({
      fetch: () => Promise.resolve(new Response('unauthorized', { status: 401 })),
      protocol: protocolEndpointsFromIssuer('https://api.test'),
      tokens,
    })
    await expect(client.listProjects()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(await store.get(TEST_KEY)).toBeNull()
  })
})

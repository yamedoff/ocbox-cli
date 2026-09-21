import { describe, expect, it, vi } from 'vitest'
import { AuthBindingError } from '../../src/auth/errors.js'
import {
  createAuthenticatedTransport,
  createHostedApiClient,
} from '../../src/auth/hosted-client.js'
import type { FetchPort } from '../../src/auth/ports.js'
import { credentialFromTokenPair, HostedTokenManager } from '../../src/auth/token-manager.js'
import { protocolEndpointsFromIssuer } from '../../src/auth/config.js'
import { fixedClock, MemoryCredentialStore, TEST_KEY, TEST_NOW, tokenPair } from './doubles.js'

const ACCESS_A = 'a'.repeat(48)
const ACCESS_B = 'b'.repeat(48)

function tokensWith(): {
  store: MemoryCredentialStore
  tokens: HostedTokenManager
  refresh: ReturnType<typeof vi.fn>
} {
  const store = new MemoryCredentialStore()
  const refresh = vi.fn(() => Promise.resolve(tokenPair('b')))
  const tokens = new HostedTokenManager({
    clock: fixedClock(TEST_NOW),
    expirySkewMilliseconds: 30_000,
    key: TEST_KEY,
    refresh,
    store,
  })
  return { refresh, store, tokens }
}

async function seeded(): Promise<ReturnType<typeof tokensWith>> {
  const h = tokensWith()
  await h.store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
  return h
}

function jsonResponse(body: unknown, status = 200, requestId = 'req_1'): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'x-request-id': requestId },
    status,
  })
}

describe('hosted API client adapter', () => {
  it('requires an explicit or credential-bound API base before building transport', () => {
    const h = tokensWith()
    expect(() => createAuthenticatedTransport(h.tokens)).toThrow(/explicit API base/i)
  })

  it('drives the generated client with bearer credentials over one API base', async () => {
    const h = await seeded()
    const seen: string[] = []
    const fetchImpl: FetchPort = (input, init) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '')
      expect(String(input).startsWith('https://api.test/v1/projects')).toBe(true)
      return Promise.resolve(jsonResponse({ data: [] }))
    }
    const client = createHostedApiClient({
      fetch: fetchImpl,
      protocol: protocolEndpointsFromIssuer('https://api.test'),
      tokens: h.tokens,
    })

    const result = await client.listProjects()
    expect(result.status).toBe(200)
    expect(result.requestId).toBe('req_1')
    expect(seen).toEqual([`Bearer ${ACCESS_A}`])
  })

  it('refreshes a replayable generated-client read once after a 401', async () => {
    const h = await seeded()
    const seen: string[] = []
    const fetchImpl: FetchPort = (_input, init) => {
      const token = (new Headers(init?.headers).get('authorization') ?? '').replace(
        /^Bearer\s+/,
        '',
      )
      seen.push(token)
      return Promise.resolve(
        token === ACCESS_A
          ? new Response('unauthorized', { status: 401 })
          : jsonResponse({ data: [] }),
      )
    }
    const client = createHostedApiClient({
      fetch: fetchImpl,
      protocol: protocolEndpointsFromIssuer('https://api.test'),
      tokens: h.tokens,
    })

    const result = await client.listProjects()
    expect(result.status).toBe(200)
    expect(seen).toEqual([ACCESS_A, ACCESS_B])
    expect(h.refresh).toHaveBeenCalledTimes(1)
  })

  it('does not burn a refresh for a generated-client mutation without an idempotency key', async () => {
    const h = await seeded()
    let count = 0
    const fetchImpl: FetchPort = () => {
      count += 1
      return Promise.resolve(new Response('unauthorized', { status: 401 }))
    }
    // createProject is a mutating operation; without an idempotency key the
    // 401 must surface without rotating the refresh family.
    const transport = createAuthenticatedTransport(h.tokens, {
      apiOrigin: 'https://api.test',
      fetch: fetchImpl,
    })
    const response = await transport.fetch('https://api.test/v1/projects', {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(response.status).toBe(401)
    expect(count).toBe(1)
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('retries a keyed mutation once and forwards the canonical idempotency key', async () => {
    const h = await seeded()
    const keys: Array<string | null> = []
    const fetchImpl: FetchPort = (_input, init) => {
      keys.push(new Headers(init?.headers).get('idempotency-key'))
      const token = (new Headers(init?.headers).get('authorization') ?? '').replace(
        /^Bearer\s+/,
        '',
      )
      return Promise.resolve(
        token === ACCESS_A
          ? new Response('unauthorized', { status: 401 })
          : jsonResponse({ id: 'project-id' }),
      )
    }
    const transport = createAuthenticatedTransport(h.tokens, {
      apiOrigin: 'https://api.test',
      fetch: fetchImpl,
    })
    const response = await transport.fetch('https://api.test/v1/projects', {
      body: '{}',
      headers: { 'IDEMPOTENCY-KEY': 'key-123' },
      method: 'POST',
    })
    expect(response.status).toBe(200)
    expect(keys).toEqual(['key-123', 'key-123'])
    expect(h.refresh).toHaveBeenCalledTimes(1)
  })

  it('refuses a foreign destination before any credential is read', async () => {
    const h = await seeded()
    let called = false
    const fetchImpl: FetchPort = () => {
      called = true
      return Promise.resolve(new Response('ok'))
    }
    const transport = createAuthenticatedTransport(h.tokens, {
      apiOrigin: 'https://api.test',
      fetch: fetchImpl,
    })
    await expect(transport.fetch('https://attacker.test/v1/projects')).rejects.toBeInstanceOf(
      AuthBindingError,
    )
    expect(called).toBe(false)
  })

  it('binds a subpath deployment subtree while keeping the generated base model', async () => {
    const h = await seeded()
    let called = false
    const fetchImpl: FetchPort = () => {
      called = true
      return Promise.resolve(jsonResponse({ data: [] }))
    }
    const client = createHostedApiClient({
      fetch: fetchImpl,
      protocol: protocolEndpointsFromIssuer('https://api.test/deploy'),
      tokens: h.tokens,
    })
    const result = await client.listProjects()
    expect(result.status).toBe(200)
    expect(called).toBe(true)
    const transport = createAuthenticatedTransport(h.tokens, {
      apiOrigin: 'https://api.test/deploy',
      fetch: () => Promise.resolve(new Response('ok')),
    })
    await expect(transport.fetch('https://api.test/other/v1/projects')).rejects.toBeInstanceOf(
      AuthBindingError,
    )
  })

  it('keeps generated-client managed headers under the authenticated transport ownership', async () => {
    const h = await seeded()
    const captured: Array<{
      auth: string | null
      idempotency: string | null
      tenant: string | null
    }> = []
    const client = createHostedApiClient({
      fetch: (_input, init) => {
        const headers = new Headers(init?.headers)
        captured.push({
          auth: headers.get('authorization'),
          idempotency: headers.get('idempotency-key'),
          tenant: headers.get('x-tenant'),
        })
        return Promise.resolve(jsonResponse({ id: 'project-id' }))
      },
      headers: {
        Authorization: 'Bearer caller-controlled',
        'IDEMPOTENCY-KEY': 'stale-default',
        'x-tenant': 'tenant-1',
      },
      protocol: protocolEndpointsFromIssuer('https://api.test'),
      tokens: h.tokens,
    })

    await client.createProject({
      body: { name: 'demo' },
      idempotencyKey: 'fresh-operation-key',
    })
    expect(captured).toEqual([
      {
        auth: `Bearer ${ACCESS_A}`,
        idempotency: 'fresh-operation-key',
        tenant: 'tenant-1',
      },
    ])
  })

  it('rejects ambiguous duplicate idempotency keys before reading credentials', async () => {
    const h = await seeded()
    let called = false
    const transport = createAuthenticatedTransport(h.tokens, {
      apiOrigin: 'https://api.test',
      fetch: () => {
        called = true
        return Promise.resolve(jsonResponse({}))
      },
    })

    await expect(
      transport.fetch('https://api.test/v1/projects', {
        headers: [
          ['Idempotency-Key', 'first'],
          ['idempotency-key', 'second'],
        ],
        method: 'POST',
      }),
    ).rejects.toBeInstanceOf(TypeError)
    expect(called).toBe(false)
  })

  it('honors explicit RequestInit clearing of a Request body and signal', async () => {
    const h = await seeded()
    const requestController = new AbortController()
    const seen: Array<{
      body: RequestInit['body']
      signal: RequestInit['signal']
    }> = []
    const transport = createAuthenticatedTransport(h.tokens, {
      apiOrigin: 'https://api.test',
      fetch: (_input, init) => {
        seen.push({ body: init?.body, signal: init?.signal })
        return Promise.resolve(jsonResponse({ data: [] }))
      },
    })
    const request = new Request('https://api.test/v1/projects', {
      body: '{}',
      method: 'POST',
      signal: requestController.signal,
    })

    const response = await transport.fetch(request, { body: null, signal: null })

    expect(response.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.body).toBeUndefined()
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(seen[0]?.signal).not.toBe(requestController.signal)
  })

  it('bounds and times out generated-client response-body reads', async () => {
    const oversizedHarness = await seeded()
    const oversized = createHostedApiClient({
      fetch: () => Promise.resolve(jsonResponse({ data: 'x'.repeat(128) })),
      maxResponseBytes: 32,
      protocol: protocolEndpointsFromIssuer('https://api.test'),
      tokens: oversizedHarness.tokens,
    })
    await expect(oversized.listProjects()).rejects.toMatchObject({ code: 'PROVIDER_AUTH' })

    const hangingHarness = await seeded()
    const hanging = createHostedApiClient({
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start() {
                // Intentionally produce neither a chunk nor EOF.
              },
            }),
          ),
        ),
      protocol: protocolEndpointsFromIssuer('https://api.test'),
      timeoutMilliseconds: 20,
      tokens: hangingHarness.tokens,
    })
    await expect(hanging.listProjects()).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' })
  })
})

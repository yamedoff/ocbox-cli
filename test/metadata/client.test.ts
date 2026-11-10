import { describe, expect, it, vi } from 'vitest'
import { createOcboxApiClient } from '../../src/api/client/index.js'
import { protocolEndpointsFromIssuer } from '../../src/auth/config.js'
import { credentialFromTokenPair, HostedTokenManager } from '../../src/auth/token-manager.js'
import {
  fixedClock,
  MemoryCredentialStore,
  TEST_KEY,
  TEST_NOW,
  tokenPair,
} from '../auth/doubles.js'
import { runMetadataAction } from '../../src/metadata/client.js'
import type { FetchPort } from '../../src/auth/ports.js'

const project = {
  id: 'project-1',
  name: 'Example',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
}
const environment = { ...project, id: 'environment-1', projectId: project.id, selected: false }

/** Exercise real generated HTTP serialization over the authenticated transport. */
async function client(body: unknown, status = 200) {
  const store = new MemoryCredentialStore()
  await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
  const fetch = vi.fn<FetchPort>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'x-request-id': 'request-1', 'idempotency-replayed': 'true' },
      }),
  )
  const tokens = new HostedTokenManager({
    store,
    key: TEST_KEY,
    clock: fixedClock(TEST_NOW),
    expirySkewMilliseconds: 30_000,
    refresh: async () => tokenPair('b'),
  })
  const api = createOcboxApiClient({
    protocol: protocolEndpointsFromIssuer('https://api.test'),
    tokens,
    fetch,
  })
  return { api, fetch }
}

describe('hosted metadata boundary', () => {
  it('returns one cursor page and forwards pagination without needing a project ID', async () => {
    const { api, fetch } = await client({ data: [project], nextCursor: 'opaque-next' })
    const result = await runMetadataAction(api, 'project.list', { cursor: 'opaque+/=', limit: 2 })
    expect(result.resource).toEqual({ data: [project], nextCursor: 'opaque-next' })
    const url = new URL(String(fetch.mock.calls[0]?.[0]))
    expect(url.searchParams.get('cursor')).toBe('opaque+/=')
    expect(url.searchParams.get('limit')).toBe('2')
    expect(result.meta.replay).toBe(true)
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      `Bearer ${'a'.repeat(48)}`,
    )
  })

  it('updates selected=false and forwards an explicit replay key', async () => {
    const { api, fetch } = await client(environment)
    const result = await runMetadataAction(api, 'environment.update', {
      environmentId: 'id/encoded',
      selected: false,
      idempotencyKey: 'metadata-update-key-1',
    })
    expect(result.resource).toEqual(environment)
    expect(String(fetch.mock.calls[0]?.[0]).endsWith('/v1/environments/id%2Fencoded')).toBe(true)
    const init = fetch.mock.calls[0]?.[1]
    expect(init?.method).toBe('PATCH')
    expect(init?.body).toBe('{"selected":false}')
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('metadata-update-key-1')
  })

  it('rejects malformed/private response fields without reflecting their contents', async () => {
    const { api } = await client({ ...project, providerToken: 'private-value' })
    await expect(
      runMetadataAction(api, 'project.get', { projectId: 'project-1' }),
    ).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'Hosted metadata response does not match the public contract',
    })
  })

  it('maps hosted authorization failures to the stable error catalogue', async () => {
    const { api } = await client(
      { error: { code: 'AUTH_FORBIDDEN', message: 'Forbidden' }, requestId: 'request-1' },
      403,
    )
    await expect(runMetadataAction(api, 'project.list', {})).rejects.toMatchObject({
      code: 'AUTH_FORBIDDEN',
    })
  })

  it('sanitizes malformed raw response bodies before reaching the output boundary', async () => {
    const { api, fetch } = await client(project)
    fetch.mockImplementationOnce(async () => new Response('fixture-private-field', { status: 200 }))
    await expect(runMetadataAction(api, 'project.list', {})).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'Hosted metadata request failed',
    })
  })

  it.each([
    ['project.create', { name: '' }],
    ['project.list', { limit: 101 }],
    ['environment.update', { environmentId: 'environment-1' }],
    ['environment.create', { name: 'valid', projectId: '' }],
    ['project.create', { name: 'valid', idempotencyKey: 'short' }],
  ] as const)('rejects invalid %s input before HTTP', async (action, input) => {
    const { api, fetch } = await client(project)
    await expect(runMetadataAction(api, action, input)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('propagates cancellation without issuing HTTP', async () => {
    const { api, fetch } = await client(project)
    const abort = new AbortController()
    abort.abort()
    await expect(runMetadataAction(api, 'project.list', {}, abort.signal)).rejects.toBeDefined()
    expect(fetch).not.toHaveBeenCalled()
  })
})

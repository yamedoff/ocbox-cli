import { createOcboxApiClient } from '../../src/api/client/index.js'
import { protocolEndpointsFromIssuer } from '../../src/auth/config.js'
import type { FetchPort } from '../../src/auth/ports.js'
import { credentialFromTokenPair, HostedTokenManager } from '../../src/auth/token-manager.js'
import { MemoryCredentialStore, TEST_KEY, fixedClock, tokenPair } from '../auth/doubles.js'
import { TEST_NOW } from '../auth/doubles.js'

export const API_ISSUER = 'https://api.test'
export const HOSTED_PROJECT = 'proj_hosted_1'
export const HOSTED_SESSION = 'sess_hosted_1'
export const HOSTED_SANDBOX = 'sbx_hosted_1'

export function jsonResponse(
  body: unknown,
  status = 200,
  requestId = '11111111-1111-4111-8111-111111111111',
): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'x-request-id': requestId },
    status,
  })
}

export function errorResponse(
  code: string,
  status: number,
  requestId = '11111111-1111-4111-8111-111111111111',
  retryAfterSeconds?: number,
): Response {
  const headers: Record<string, string> = { 'x-request-id': requestId }
  if (retryAfterSeconds !== undefined) headers['retry-after'] = String(retryAfterSeconds)
  return new Response(
    JSON.stringify({
      error: {
        code,
        message: 'mock failure',
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      },
      requestId,
    }),
    { headers, status },
  )
}

export async function seededApi(fetchImpl: FetchPort): Promise<{
  store: MemoryCredentialStore
  tokens: HostedTokenManager
  api: ReturnType<typeof createOcboxApiClient>
}> {
  const store = new MemoryCredentialStore()
  await store.set(TEST_KEY, credentialFromTokenPair(tokenPair('a'), TEST_NOW))
  const tokens = new HostedTokenManager({
    clock: fixedClock(TEST_NOW),
    expirySkewMilliseconds: 30_000,
    key: TEST_KEY,
    refresh: () => Promise.resolve(tokenPair('b')),
    store,
  })
  const api = createOcboxApiClient({
    fetch: fetchImpl,
    protocol: protocolEndpointsFromIssuer(API_ISSUER),
    tokens,
  })
  return { api, store, tokens }
}

export function hostedSessionFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    createdAt: '2026-09-12T10:00:00.000Z',
    effectiveSpec: {},
    id: HOSTED_SESSION,
    normalizedState: 'running',
    primarySandboxId: HOSTED_SANDBOX,
    projectId: HOSTED_PROJECT,
    rawState: 'running',
    requestedSpec: {},
    sandboxes: [
      {
        active: true,
        boundAt: '2026-09-12T10:00:00.000Z',
        ordinal: 0,
        releasedAt: null,
        role: 'primary',
        sandboxId: HOSTED_SANDBOX,
        state: 'running',
      },
    ],
    updatedAt: '2026-09-12T10:01:00.000Z',
    ...overrides,
  }
}

export function hostedOperationFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    createdAt: '2026-09-12T10:00:00.000Z',
    error: null,
    id: 'op_hosted_1',
    kind: 'session_create',
    progress: 100,
    projectId: HOSTED_PROJECT,
    requestId: '11111111-1111-4111-8111-111111111111',
    resource: null,
    sessionId: HOSTED_SESSION,
    state: 'succeeded',
    updatedAt: '2026-09-12T10:01:00.000Z',
    ...overrides,
  }
}

export const LOCAL_IDS = {
  operation: '22222222-2222-4222-8222-222222222222',
  project: '33333333-3333-4333-8333-333333333333',
  request: '44444444-4444-4434-8434-444444444444',
  sandbox: '55555555-5555-4555-8555-555555555555',
  session: '66666666-6666-4666-8666-666666666666',
} as const

export function operationContext(overrides: Record<string, unknown> = {}): {
  operationId: string
  requestId: string
  issuedAt: string
  idempotencyKey: string
  attempt: number
} {
  return {
    attempt: 1,
    idempotencyKey: 'test-key-0123456789-abcd',
    issuedAt: '2026-09-12T10:00:00.000Z',
    operationId: LOCAL_IDS.operation,
    requestId: LOCAL_IDS.request,
    ...overrides,
  }
}

export function testSpec(): Record<string, unknown> {
  return {
    architecture: 'x86_64',
    cpu: { millicores: 1000 },
    disk: { bytes: 10737418240 },
    environment: { name: 'development', secretReferenceIds: [], variableNames: [] },
    image: { kind: 'template', reference: 'fake-node-24' },
    lifecycle: {
      autoDestroyAfterMilliseconds: null,
      autoStopAfterMilliseconds: null,
      idleTimeoutMilliseconds: null,
      maximumRuntimeMilliseconds: null,
    },
    memory: { bytes: 2147483648 },
    network: {
      allowedHosts: [],
      directInbound: 'blocked',
      egress: 'open',
      previews: 'authenticated_only',
    },
    operatingSystem: 'linux',
    providerClass: 'container',
    region: 'local',
    source: { kind: 'none' },
  }
}

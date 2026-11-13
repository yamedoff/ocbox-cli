import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOcboxApiClient } from '../../src/api/client/index.js'
import { protocolEndpointsFromIssuer } from '../../src/auth/config.js'
import { credentialFromTokenPair, HostedTokenManager } from '../../src/auth/token-manager.js'
import { ProjectIdSchema, SessionIdSchema } from '../../src/domain/ids.js'
import { createCasTransport } from '../../src/providers/ocbox/cas.js'
import { type CasPage, casHash } from '../../src/sync/cas-contract.js'
import { renderSyncApplied, runSyncApply, type SyncContext } from '../../src/sync/service.js'
import {
  fixedClock,
  MemoryCredentialStore,
  TEST_KEY,
  TEST_NOW,
  tokenPair,
} from '../auth/doubles.js'

const HOSTED_SESSION = `ses_${'1'.repeat(30)}`
const roots: string[] = []
const servers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

function file(path: string, content: string) {
  const bytes = Buffer.from(content)
  return {
    path,
    type: 'file' as const,
    hash: sha(bytes),
    size: bytes.length,
    mode: 420,
    parts: bytes.length === 0 ? [] : [{ hash: sha(bytes), offset: 0, size: bytes.length }],
  }
}

function page(index: number, files: ReturnType<typeof file>[]): CasPage {
  const blobs = [
    ...new Map(
      files.flatMap((entry) => entry.parts.map((part) => [part.hash, part.size] as const)),
    ).entries(),
  ]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([hash, size]) => ({ hash, size }))
  return { index, files: files as CasPage['files'], blobs }
}

function manifest(pages: CasPage[]) {
  return {
    syncId: 'a'.repeat(32),
    pageHashes: pages.map((entry) => casHash({ files: entry.files, blobs: entry.blobs })),
    fileCount: pages.reduce((total, entry) => total + entry.files.length, 0),
    totalBytes: pages.reduce(
      (total, entry) =>
        total +
        entry.files.reduce((bytes, item) => bytes + (item.type === 'file' ? item.size : 0), 0),
      0,
    ),
  }
}

interface RecordedRequest {
  readonly body: Record<string, unknown>
  readonly idempotencyKey: string | undefined
  readonly method: string
  readonly path: string
}

async function serve(
  handler: (request: RecordedRequest, response: ServerResponse) => void | Promise<void>,
): Promise<{ origin: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = []
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString('utf8')
    const recorded: RecordedRequest = {
      body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
      idempotencyKey:
        typeof request.headers['idempotency-key'] === 'string'
          ? request.headers['idempotency-key']
          : undefined,
      method: request.method ?? 'GET',
      path: request.url ?? '/',
    }
    requests.push(recorded)
    await handler(recorded, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  servers.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  )
  return { origin, requests }
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'x-request-id': 'req_test',
  })
  response.end(JSON.stringify(body))
}

async function contextFor(origin: string, localRoot: string): Promise<SyncContext> {
  const root = dirname(localRoot)
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
    protocol: protocolEndpointsFromIssuer(origin),
    tokens,
  })
  return {
    providerName: 'ocbox',
    projectId: ProjectIdSchema.parse('11111111-1111-4111-8111-111111111111'),
    sessionId: SessionIdSchema.parse('22222222-2222-4222-8222-222222222222'),
    stateDirectory: join(root, 'state'),
    localRoot,
    remoteRoot: join(root, 'remote'),
    casTransport: createCasTransport(api, HOSTED_SESSION),
  }
}

async function localRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ocbox-cas-fast-'))
  roots.push(root)
  const local = join(root, 'local')
  await mkdir(local)
  return local
}

const options = {
  cliRules: [],
  delete: false,
  yes: false,
  interactive: false,
  confirm: async () => false,
  pause: async () => {},
}

function v2Routes(request: RecordedRequest, response: ServerResponse, pages: CasPage[]): boolean {
  if (request.path.endsWith('/source/cas/plan')) {
    json(response, {
      version: 2,
      planId: `casdo_${'a'.repeat(30)}`,
      state: 'uploading',
      expiresAt: Date.now() + 60_000,
      replayed: false,
      missing: [],
    })
    return true
  }
  if (request.path.endsWith('/source/cas/apply')) {
    json(response, {
      version: 2,
      planId: `casdo_${'a'.repeat(30)}`,
      state: 'succeeded',
      expiresAt: Date.now() + 60_000,
      replayed: false,
      fetchedBlobs: 0,
      fetchedBytes: 0,
    })
    return true
  }
  if (request.path.endsWith('/source/cas/snapshot')) {
    json(response, {
      version: 2,
      snapshotId: `cssnap_${'a'.repeat(30)}`,
      state: 'succeeded',
      expiresAt: Date.now() + 60_000,
      replayed: false,
      manifest: manifest(pages),
      page: pages[0],
    })
    return true
  }
  return false
}

describe('CAS v3 fast re-sync', () => {
  it('stops after the check when the tree is unchanged', async () => {
    const local = await localRoot()
    await writeFile(join(local, 'a.txt'), 'one')
    const pages = [page(0, [file('a.txt', 'one')])]
    let checkState: 'unchanged' | 'changed' = 'changed'
    const { origin, requests } = await serve((request, response) => {
      if (request.path.endsWith('/source/cas/check')) {
        json(response, {
          version: 3,
          state: checkState,
          changedPaths: [],
          changedCount: 0,
          editedPaths: [],
          editedCount: 0,
          replayed: false,
        })
        return
      }
      if (!v2Routes(request, response, pages))
        json(response, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
    })
    const context = await contextFor(origin, local)
    await runSyncApply(context, 'push', options)
    const before = requests.length
    checkState = 'unchanged'
    const view = await runSyncApply(context, 'push', options)
    expect(requests.length - before).toBe(1)
    expect(requests.at(-1)?.path).toContain('/source/cas/check')
    expect(renderSyncApplied(view)).toBe('Source unchanged.')
  })

  it('uses the fast apply for a one-file change', async () => {
    const local = await localRoot()
    await writeFile(join(local, 'a.txt'), 'one')
    const pages = [page(0, [file('a.txt', 'one')])]
    const fastBodies: Record<string, unknown>[] = []
    const { origin, requests } = await serve((request, response) => {
      if (request.path.endsWith('/source/cas/check')) {
        json(response, {
          version: 3,
          state: 'changed',
          changedPaths: ['a.txt'],
          changedCount: 1,
          editedPaths: [],
          editedCount: 0,
          replayed: false,
        })
        return
      }
      if (request.path.endsWith('/source/cas/fast')) {
        fastBodies.push(request.body)
        json(response, {
          version: 3,
          state: 'applied',
          fingerprint: request.body['fingerprint'],
          missing: [],
          writtenFiles: 1,
          linkedFiles: 0,
          removedFiles: 0,
          fetchedBlobs: 0,
          fetchedBytes: 0,
          replayed: false,
        })
        return
      }
      if (!v2Routes(request, response, pages))
        json(response, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
    })
    const context = await contextFor(origin, local)
    await runSyncApply(context, 'push', options)
    const plansBefore = requests.filter((entry) => entry.path.endsWith('/source/cas/plan')).length
    await writeFile(join(local, 'a.txt'), 'two')
    const view = await runSyncApply(context, 'push', options)
    expect(fastBodies).toHaveLength(1)
    expect(fastBodies[0]?.['files']).toEqual([
      expect.objectContaining({ path: 'a.txt', type: 'file' }),
    ])
    expect(requests.filter((entry) => entry.path.endsWith('/source/cas/plan'))).toHaveLength(
      plansBefore,
    )
    expect(renderSyncApplied(view)).toContain('1 modification(s)')
  })

  it('asks the box once for a push with a local delta', async () => {
    const local = await localRoot()
    await writeFile(join(local, 'a.txt'), 'one')
    const pages = [page(0, [file('a.txt', 'one')])]
    const { origin, requests } = await serve((request, response) => {
      if (request.path.endsWith('/source/cas/check')) {
        json(response, {
          version: 3,
          state: 'changed',
          changedPaths: ['a.txt'],
          changedCount: 1,
          editedPaths: [],
          editedCount: 0,
          replayed: false,
        })
        return
      }
      if (request.path.endsWith('/source/cas/fast')) {
        json(response, {
          version: 3,
          state: 'applied',
          fingerprint: request.body['fingerprint'],
          missing: [],
          writtenFiles: 1,
          linkedFiles: 0,
          removedFiles: 0,
          fetchedBlobs: 0,
          fetchedBytes: 0,
          replayed: false,
        })
        return
      }
      if (!v2Routes(request, response, pages))
        json(response, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
    })
    const context = await contextFor(origin, local)
    await runSyncApply(context, 'push', options)
    const before = requests.length
    await writeFile(join(local, 'a.txt'), 'two')
    const view = await runSyncApply(context, 'push', options)
    expect(requests.length - before).toBe(1)
    expect(requests.at(-1)?.path).toContain('/source/cas/fast')
    expect(renderSyncApplied(view)).toContain('1 modification(s)')
  })

  it('runs the skipped check and reports the conflict when the fast apply answers changed', async () => {
    const local = await localRoot()
    await writeFile(join(local, 'a.txt'), 'one')
    const pages = [page(0, [file('a.txt', 'one')])]
    let checkRequests = 0
    const { origin, requests } = await serve((request, response) => {
      if (request.path.endsWith('/source/cas/check')) {
        checkRequests += 1
        json(response, {
          version: 3,
          state: 'changed',
          changedPaths: ['a.txt'],
          changedCount: 1,
          editedPaths: ['b.txt'],
          editedCount: 1,
          replayed: false,
        })
        return
      }
      if (request.path.endsWith('/source/cas/fast')) {
        json(response, {
          version: 3,
          state: 'changed',
          fingerprint: 'c'.repeat(64),
          missing: [],
          writtenFiles: 0,
          linkedFiles: 0,
          removedFiles: 0,
          fetchedBlobs: 0,
          fetchedBytes: 0,
          editedPaths: ['b.txt'],
          editedCount: 1,
          replayed: false,
        })
        return
      }
      if (!v2Routes(request, response, pages))
        json(response, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
    })
    const context = await contextFor(origin, local)
    await runSyncApply(context, 'push', options)
    const before = requests.length
    await writeFile(join(local, 'a.txt'), 'two')
    await expect(runSyncApply(context, 'push', options)).rejects.toMatchObject({
      code: 'SYNC_CONFLICT',
      message: 'Source sync conflicts with the workspace; resolve it and retry',
    })
    const after = requests.slice(before).map((entry) => entry.path)
    expect(after).toHaveLength(2)
    expect(after[0]).toContain('/source/cas/fast')
    expect(after[1]).toContain('/source/cas/check')
    expect(checkRequests).toBe(2)
  })

  it('keeps the check first when the local delta deletes a path', async () => {
    const local = await localRoot()
    await writeFile(join(local, 'a.txt'), 'one')
    await writeFile(join(local, 'b.txt'), 'two')
    const pages = [page(0, [file('a.txt', 'one'), file('b.txt', 'two')])]
    let checkState: 'unchanged' | 'changed' = 'changed'
    const { origin, requests } = await serve((request, response) => {
      if (request.path.endsWith('/source/cas/check')) {
        json(response, {
          version: 3,
          state: checkState,
          changedPaths: [],
          changedCount: 0,
          editedPaths: [],
          editedCount: 0,
          replayed: false,
        })
        return
      }
      if (!v2Routes(request, response, pages))
        json(response, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
    })
    const context = await contextFor(origin, local)
    await runSyncApply(context, 'push', options)
    const before = requests.length
    await rm(join(local, 'b.txt'))
    checkState = 'unchanged'
    const view = await runSyncApply(context, 'push', options)
    expect(renderSyncApplied(view)).toBe('Source unchanged.')
    expect(requests.slice(before).map((entry) => entry.path)).toEqual([
      expect.stringContaining('/source/cas/check'),
    ])
  })

  it('clears the pending snapshot when the fast apply reports a conflict', async () => {
    const local = await localRoot()
    await writeFile(join(local, 'a.txt'), 'one')
    const pages = [page(0, [file('a.txt', 'one')])]
    const { origin } = await serve((request, response) => {
      if (request.path.endsWith('/source/cas/check')) {
        json(response, {
          version: 3,
          state: 'changed',
          changedPaths: ['a.txt'],
          changedCount: 1,
          editedPaths: ['b.txt'],
          editedCount: 1,
          replayed: false,
        })
        return
      }
      if (request.path.endsWith('/source/cas/fast')) {
        json(response, {
          version: 3,
          state: 'changed',
          fingerprint: 'c'.repeat(64),
          missing: [],
          writtenFiles: 0,
          linkedFiles: 0,
          removedFiles: 0,
          fetchedBlobs: 0,
          fetchedBytes: 0,
          editedPaths: ['b.txt'],
          editedCount: 1,
          replayed: false,
        })
        return
      }
      if (!v2Routes(request, response, pages))
        json(response, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
    })
    const context = await contextFor(origin, local)
    await runSyncApply(context, 'push', options)
    await writeFile(join(local, 'a.txt'), 'two')
    await expect(runSyncApply(context, 'push', options)).rejects.toMatchObject({
      code: 'SYNC_CONFLICT',
    })
    const transport = context.casTransport
    if (transport === undefined) throw new Error('expected a CAS transport')
    const key = createHash('sha256')
      .update(JSON.stringify([transport.scope, context.localRoot]))
      .digest('hex')
    const pending = join(
      context.stateDirectory,
      'sync',
      context.projectId,
      context.sessionId,
      'cas',
      key,
      'pending.json',
    )
    await expect(stat(pending)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('falls back to the v2 cycle when the server has no check route', async () => {
    const local = await localRoot()
    await writeFile(join(local, 'a.txt'), 'one')
    const pages = [page(0, [file('a.txt', 'one')])]
    const { origin, requests } = await serve((request, response) => {
      if (request.path.endsWith('/source/cas/check')) {
        json(response, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
        return
      }
      if (!v2Routes(request, response, pages))
        json(response, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
    })
    const context = await contextFor(origin, local)
    const view = await runSyncApply(context, 'push', options)
    expect(requests.some((entry) => entry.path.endsWith('/source/cas/check'))).toBe(true)
    expect(requests.some((entry) => entry.path.endsWith('/source/cas/plan'))).toBe(true)
    expect(requests.some((entry) => entry.path.endsWith('/source/cas/apply'))).toBe(true)
    expect(renderSyncApplied(view)).toContain('Source synced: 1 addition(s)')
  })
})

import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOcboxApiClient } from '../../src/api/client/index.js'
import { protocolEndpointsFromIssuer } from '../../src/auth/config.js'
import { credentialFromTokenPair, HostedTokenManager } from '../../src/auth/token-manager.js'
import { ProjectIdSchema, SessionIdSchema } from '../../src/domain/ids.js'
import { createCasTransport } from '../../src/providers/ocbox/cas.js'
import { casHash, type CasPage } from '../../src/sync/cas-contract.js'
import {
  renderSyncApplied,
  renderSyncPlan,
  runSyncApply,
  runSyncDiff,
  type SyncContext,
} from '../../src/sync/service.js'
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

function file(path: string, content: string, mode = 420) {
  const bytes = Buffer.from(content)
  return {
    path,
    type: 'file' as const,
    hash: sha(bytes),
    size: bytes.length,
    mode,
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
    casReadTransport: createCasTransport(api, HOSTED_SESSION),
  }
}

async function localRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ocbox-hosted-pull-'))
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

describe('hosted sync read-back', () => {
  it('refreshes a snapshot and reports added, modified and deleted paths against the local tree', async () => {
    const local = await localRoot()
    await writeFile(join(local, 'modified.txt'), 'old')
    await writeFile(join(local, 'deleted.txt'), 'local')
    await writeFile(join(local, 'same.txt'), 'same')
    const pages = [
      page(0, [file('added.txt', 'added'), file('modified.txt', 'new'), file('same.txt', 'same')]),
    ]
    let snapshots = 0
    const { origin, requests } = await serve((request, response) => {
      if (request.path.endsWith('/source/cas/snapshot')) {
        snapshots += 1
        if (snapshots === 1)
          return json(
            response,
            {
              version: 2,
              snapshotId: `cssnap_${'a'.repeat(30)}`,
              state: 'pending',
              expiresAt: Date.now() + 60_000,
              replayed: false,
            },
            202,
          )
        return json(response, {
          version: 2,
          snapshotId: `cssnap_${'a'.repeat(30)}`,
          state: 'succeeded',
          expiresAt: Date.now() + 60_000,
          replayed: false,
          manifest: manifest(pages),
          page: pages[0],
        })
      }
      return json(response, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
    })
    const context = await contextFor(origin, local)
    const view = await runSyncDiff(context, { cliRules: [], pause: async () => {} })
    expect(view.additions).toEqual([{ side: 'remote', kind: 'file', path: 'added.txt' }])
    expect(view.modifications).toEqual([{ side: 'remote', kind: 'file', path: 'modified.txt' }])
    expect(view.deletions).toEqual([{ side: 'local', kind: 'file', path: 'deleted.txt' }])
    const rendered = renderSyncPlan(view)
    expect(rendered).toContain('+ file remote:added.txt')
    expect(rendered).toContain('~ file remote:modified.txt')
    expect(rendered).toContain('- file local:deleted.txt')
    const snapshotRequests = requests.filter((entry) => entry.path.endsWith('/source/cas/snapshot'))
    expect(snapshotRequests).toHaveLength(2)
    expect(snapshotRequests[0]?.body).toEqual({ version: 2, refresh: true })
    expect(snapshotRequests[1]?.idempotencyKey).toBe(snapshotRequests[0]?.idempotencyKey)
  })

  it('pulls the changed files across two capability pages and leaves local-only files alone', async () => {
    const local = await localRoot()
    await writeFile(join(local, 'modified.txt'), 'old')
    await writeFile(join(local, 'deleted.txt'), 'local')
    const added = file('added.txt', 'added')
    const modified = file('modified.txt', 'new')
    const pages = [page(0, [added]), page(1, [modified])]
    const blobs = new Map(
      pages.flatMap((entry) => entry.blobs.map((blob) => [blob.hash, blob] as const)),
    )
    const { origin, requests } = await serve((request, response) => {
      if (request.path.endsWith('/source/cas/snapshot'))
        return json(response, {
          version: 2,
          snapshotId: `cssnap_${'a'.repeat(30)}`,
          state: 'succeeded',
          expiresAt: Date.now() + 60_000,
          replayed: false,
          manifest: manifest(pages),
          page: pages[0],
        })
      if (request.path.endsWith('/source/cas/snapshot/page')) {
        const index = request.body['index'] as number
        return json(response, {
          version: 2,
          snapshotId: `cssnap_${'a'.repeat(30)}`,
          state: 'succeeded',
          page: pages[index],
        })
      }
      if (request.path.endsWith('/source/cas/pull')) {
        const cursor = request.body['cursor']
        const selected = cursor === undefined ? added : modified
        const part = selected.parts[0]
        const blob = part === undefined ? undefined : blobs.get(part.hash)
        return json(response, {
          version: 2,
          pullId: `caspull_${'b'.repeat(30)}`,
          snapshotId: `cssnap_${'a'.repeat(30)}`,
          state: 'succeeded',
          expiresAt: Date.now() + 60_000,
          replayed: false,
          blobs: blob === undefined ? [] : [{ ...blob, url: `${origin}/blob/${blob.hash}` }],
          nextCursor: cursor === undefined ? 'next-page' : null,
          uploadedBlobs: 0,
          uploadedBytes: 0,
        })
      }
      if (request.path.startsWith('/blob/')) {
        const hash = request.path.slice('/blob/'.length)
        const bytes = hash === added.parts[0]?.hash ? 'added' : 'new'
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end(bytes)
        return
      }
      return json(response, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
    })
    const context = await contextFor(origin, local)
    const view = await runSyncApply(context, 'pull', options)
    expect(await readFile(join(local, 'added.txt'), 'utf8')).toBe('added')
    expect(await readFile(join(local, 'modified.txt'), 'utf8')).toBe('new')
    expect(await readFile(join(local, 'deleted.txt'), 'utf8')).toBe('local')
    expect(view.pulledFiles).toEqual(['added.txt', 'modified.txt'])
    expect(view.pulledBytes).toBe(8)
    expect(renderSyncApplied(view)).toContain('Source pulled: 1 addition(s), 1 modification(s)')
    expect(renderSyncApplied(view)).toContain('1 local deletion(s) skipped')
    const pullRequests = requests.filter((entry) => entry.path.endsWith('/source/cas/pull'))
    expect(pullRequests).toHaveLength(2)
    expect(pullRequests[0]?.body['paths']).toEqual(['added.txt', 'modified.txt'])
    expect(pullRequests[1]?.body['cursor']).toBe('next-page')
    expect(pullRequests[1]?.idempotencyKey).toBe(pullRequests[0]?.idempotencyKey)
    const snapshotPageRequests = requests.filter((entry) =>
      entry.path.endsWith('/source/cas/snapshot/page'),
    )
    expect(snapshotPageRequests.map((entry) => entry.body['index'])).toEqual([1])

    const deleted = await runSyncApply(context, 'pull', {
      ...options,
      delete: true,
      yes: true,
    })
    expect(await readFile(join(local, 'deleted.txt'), 'utf8').catch(() => null)).toBeNull()
    expect(deleted.deletedFiles).toEqual(['deleted.txt'])
  })

  it('fails a hash mismatch without writing the target file', async () => {
    const local = await localRoot()
    const added = file('added.txt', 'expected')
    const pages = [page(0, [added])]
    const { origin } = await serve((request, response) => {
      if (request.path.endsWith('/source/cas/snapshot'))
        return json(response, {
          version: 2,
          snapshotId: `cssnap_${'a'.repeat(30)}`,
          state: 'succeeded',
          expiresAt: Date.now() + 60_000,
          replayed: false,
          manifest: manifest(pages),
          page: pages[0],
        })
      if (request.path.endsWith('/source/cas/pull'))
        return json(response, {
          version: 2,
          pullId: `caspull_${'b'.repeat(30)}`,
          snapshotId: `cssnap_${'a'.repeat(30)}`,
          state: 'succeeded',
          expiresAt: Date.now() + 60_000,
          replayed: false,
          blobs: [
            {
              hash: added.parts[0]?.hash,
              size: added.size,
              url: `${origin}/blob/wrong`,
            },
          ],
          nextCursor: null,
        })
      if (request.path.startsWith('/blob/')) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end('corrupt')
        return
      }
      return json(response, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
    })
    const context = await contextFor(origin, local)
    await expect(runSyncApply(context, 'pull', options)).rejects.toMatchObject({
      code: 'SYNC_INTEGRITY',
      message: expect.stringMatching(/hash verification/),
    })
    await expect(readFile(join(local, 'added.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports a clear message when the server has no pull route', async () => {
    const local = await localRoot()
    const added = file('added.txt', 'expected')
    const pages = [page(0, [added])]
    const { origin } = await serve((request, response) => {
      if (request.path.endsWith('/source/cas/snapshot'))
        return json(response, {
          version: 2,
          snapshotId: `cssnap_${'a'.repeat(30)}`,
          state: 'succeeded',
          expiresAt: Date.now() + 60_000,
          replayed: false,
          manifest: manifest(pages),
          page: pages[0],
        })
      return json(
        response,
        { error: { code: 'NOT_FOUND', message: 'Resource was not found' }, requestId: 'req_test' },
        404,
      )
    })
    const context = await contextFor(origin, local)
    await expect(runSyncApply(context, 'pull', options)).rejects.toThrow(
      'Server does not support sync pull yet',
    )
    await expect(readFile(join(local, 'added.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

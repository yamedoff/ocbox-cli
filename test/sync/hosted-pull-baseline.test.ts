import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOcboxApiClient } from '../../src/api/client/index.js'
import { protocolEndpointsFromIssuer } from '../../src/auth/config.js'
import { credentialFromTokenPair, HostedTokenManager } from '../../src/auth/token-manager.js'
import { ProjectIdSchema, SessionIdSchema } from '../../src/domain/ids.js'
import { UtcTimestampSchema } from '../../src/domain/timestamps.js'
import { createCasTransport } from '../../src/providers/ocbox/cas.js'
import { createVerifiedBaseline } from '../../src/sync/baseline.js'
import { SyncBaselineStore } from '../../src/sync/baseline-store.js'
import { type CasPage, casHash } from '../../src/sync/cas-contract.js'
import { readCasState } from '../../src/sync/cas-snapshot.js'
import { scanSourceManifest } from '../../src/sync/manifest.js'
import {
  runSyncApply,
  runSyncDiff,
  type SyncApplyOptions,
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
const PROJECT_ID = ProjectIdSchema.parse('11111111-1111-4111-8111-111111111111')
const SESSION_ID = SessionIdSchema.parse('22222222-2222-4222-8222-222222222222')
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

async function contextFor(origin: string, localRoot: string, stateDirectory: string) {
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
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    stateDirectory,
    localRoot,
    remoteRoot: join(dirname(localRoot), 'remote'),
    casReadTransport: createCasTransport(api, HOSTED_SESSION),
    // The pull path writes the last synced tree here; the call itself is not
    // used unless a test pushes, which this file does not do.
    casTransport: {
      scope: 'test',
      sessionId: 'sesdo_test',
      call: async () => {
        throw new Error('unexpected CAS call')
      },
    },
  } satisfies SyncContext
}

const options: SyncApplyOptions = {
  cliRules: [],
  delete: false,
  yes: false,
  interactive: false,
  confirm: async () => false,
  pause: async () => {},
}

/** Mirrors the per-Session/per-root CAS state path without importing new source. */
function casStatePath(context: SyncContext): string {
  const key = createHash('sha256')
    .update(JSON.stringify(['test', context.localRoot]))
    .digest('hex')
  return join(
    context.stateDirectory,
    'sync',
    context.projectId,
    context.sessionId,
    'cas',
    key,
    'state.json',
  )
}

interface Tree {
  readonly [path: string]: string
}

async function writeTree(root: string, tree: Tree): Promise<void> {
  for (const [path, content] of Object.entries(tree)) {
    const target = join(root, ...path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
}

/**
 * Writes the three-way baseline through the real store, lays down the local
 * tree, and serves the box snapshot built from `remote`.
 */
async function setup(input: { baseline: Tree; local: Tree; remote: Tree }) {
  const root = await mkdtemp(join(tmpdir(), 'ocbox-hosted-pull-baseline-'))
  roots.push(root)
  const localRoot = join(root, 'local')
  const baselineRoot = join(root, 'baseline')
  const stateDirectory = join(root, 'state')
  await mkdir(localRoot)
  await mkdir(baselineRoot)
  await writeTree(localRoot, input.local)
  await writeTree(baselineRoot, input.baseline)
  await new SyncBaselineStore(stateDirectory, PROJECT_ID, SESSION_ID).save(
    createVerifiedBaseline(
      await scanSourceManifest(baselineRoot),
      UtcTimestampSchema.parse('2026-11-26T00:00:00.000Z'),
    ),
  )

  const remoteFiles = Object.entries(input.remote).map(([path, content]) => file(path, content))
  const pages = [page(0, remoteFiles)]
  const blobs = new Map(pages.flatMap((entry) => entry.blobs.map((blob) => [blob.hash, blob])))
  const bytesByHash = new Map(
    Object.values(input.remote).map((content) => [sha(content), Buffer.from(content)] as const),
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
    if (request.path.endsWith('/source/cas/pull')) {
      const selected = (request.body['paths'] as string[] | undefined) ?? []
      const parts = remoteFiles
        .filter((entry) => selected.includes(entry.path))
        .flatMap((entry) => entry.parts)
      const capabilities = [
        ...new Map(
          parts
            .map((part) => blobs.get(part.hash))
            .filter((blob): blob is { hash: string; size: number } => blob !== undefined)
            .map((blob) => [blob.hash, blob] as const),
        ).values(),
      ].map((blob) => ({ ...blob, url: `${origin}/blob/${blob.hash}` }))
      return json(response, {
        version: 2,
        pullId: `caspull_${'b'.repeat(30)}`,
        snapshotId: `cssnap_${'a'.repeat(30)}`,
        state: 'succeeded',
        expiresAt: Date.now() + 60_000,
        replayed: false,
        blobs: capabilities,
        nextCursor: null,
      })
    }
    if (request.path.startsWith('/blob/')) {
      const bytes = bytesByHash.get(request.path.slice('/blob/'.length))
      if (bytes === undefined)
        return json(response, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(bytes)
      return
    }
    return json(response, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
  })
  return {
    context: await contextFor(origin, localRoot, stateDirectory),
    localRoot,
    requests,
  }
}

const pullRequests = (requests: readonly RecordedRequest[]) =>
  requests.filter((request) => request.path.endsWith('/source/cas/pull'))

describe('hosted pull three-way baseline', () => {
  it('leaves a local edit alone when the box did not change that path', async () => {
    const { context, localRoot, requests } = await setup({
      baseline: { 'a.txt': 'original' },
      local: { 'a.txt': 'local edit' },
      remote: { 'a.txt': 'original' },
    })

    const view = await runSyncApply(context, 'pull', options)

    expect(view.conflicts).toEqual([])
    expect(view.pulledFiles).toEqual([])
    expect(view.deletedFiles).toEqual([])
    expect(view.applied).toBe(false)
    expect(await readFile(join(localRoot, 'a.txt'), 'utf8')).toBe('local edit')
    expect(pullRequests(requests)).toEqual([])
  })

  it('does not re-create a locally deleted file when the box did not change that path', async () => {
    const { context, localRoot, requests } = await setup({
      baseline: { 'a.txt': 'original' },
      local: {},
      remote: { 'a.txt': 'original' },
    })

    const view = await runSyncApply(context, 'pull', options)

    expect(view.conflicts).toEqual([])
    expect(view.pulledFiles).toEqual([])
    expect(view.deletedFiles).toEqual([])
    expect(view.applied).toBe(false)
    expect((await readdir(localRoot)).sort()).toEqual([])
    expect(pullRequests(requests)).toEqual([])
  })

  it('pulls a box change when the local copy still matches the baseline', async () => {
    const { context, localRoot, requests } = await setup({
      baseline: { 'a.txt': 'original' },
      local: { 'a.txt': 'original' },
      remote: { 'a.txt': 'box' },
    })

    const view = await runSyncApply(context, 'pull', options)

    expect(view.conflicts).toEqual([])
    expect(view.pulledFiles).toEqual(['a.txt'])
    expect(view.baselineUpdated).toBe(true)
    expect(await readFile(join(localRoot, 'a.txt'), 'utf8')).toBe('box')
    expect(pullRequests(requests).map((request) => request.body['paths'])).toEqual([['a.txt']])
  })

  it('records the box tree as the last synced CAS state so diff and push agree', async () => {
    const { context, localRoot } = await setup({
      baseline: { 'a.txt': 'original', 'keep.txt': 'keep' },
      local: { 'a.txt': 'original', 'keep.txt': 'keep' },
      remote: { 'a.txt': 'original' },
    })

    const pulled = await runSyncApply(context, 'pull', {
      ...options,
      delete: true,
      yes: true,
    })
    expect(pulled.deletedFiles).toEqual(['keep.txt'])

    const state = await readCasState(casStatePath(context))
    expect(state?.pages.flatMap((page) => page.files).map((entry) => entry.path)).toEqual(['a.txt'])
    const diff = await runSyncDiff(context, { cliRules: [], pause: async () => {} })
    expect(diff.additions).toEqual([])
    expect(diff.modifications).toEqual([])
    expect(diff.deletions).toEqual([])
    expect(diff.conflicts).toEqual([])
    expect((await readdir(localRoot)).sort()).toEqual(['a.txt'])
  })
})

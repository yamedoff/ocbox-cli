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
import { UtcTimestampSchema } from '../../src/domain/timestamps.js'
import { OcboxError } from '../../src/errors/index.js'
import { createCasTransport } from '../../src/providers/ocbox/cas.js'
import { createVerifiedBaseline } from '../../src/sync/baseline.js'
import { SyncBaselineStore } from '../../src/sync/baseline-store.js'
import { casHash, type CasPage } from '../../src/sync/cas-contract.js'
import { scanSourceManifest } from '../../src/sync/manifest.js'
import {
  renderSyncApplied,
  renderSyncPlan,
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

async function runFailure(promise: Promise<unknown>): Promise<OcboxError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(OcboxError)
    return error as OcboxError
  }
  throw new Error('Expected the sync operation to fail')
}

/**
 * Writes the three-way baseline through the real store, then serves a box
 * snapshot whose only file is `remote`. The local tree already holds `local`.
 */
async function setup(input: { baseline: string | null; local: string; remote: string }) {
  const root = await mkdtemp(join(tmpdir(), 'ocbox-hosted-pull-conflict-'))
  roots.push(root)
  const localRoot = join(root, 'local')
  const baselineRoot = join(root, 'baseline')
  const stateDirectory = join(root, 'state')
  await mkdir(localRoot)
  await mkdir(baselineRoot)
  await writeFile(join(localRoot, 'a.txt'), input.local)
  if (input.baseline !== null) {
    await writeFile(join(baselineRoot, 'a.txt'), input.baseline)
    await new SyncBaselineStore(stateDirectory, PROJECT_ID, SESSION_ID).save(
      createVerifiedBaseline(
        await scanSourceManifest(baselineRoot),
        UtcTimestampSchema.parse('2026-11-26T00:00:00.000Z'),
      ),
    )
  }

  const remoteFile = file('a.txt', input.remote)
  const pages = [page(0, [remoteFile])]
  const blobs = new Map(pages.flatMap((entry) => entry.blobs.map((blob) => [blob.hash, blob])))
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
      const parts = selected.includes('a.txt') ? remoteFile.parts : []
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
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(input.remote)
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

describe('hosted pull keeps local work', () => {
  it('refuses to overwrite a locally changed file and names the path in text and details', async () => {
    const { context, localRoot } = await setup({
      baseline: 'original',
      local: 'local edit',
      remote: 'box',
    })

    const error = await runFailure(runSyncApply(context, 'pull', options))

    expect(error.code).toBe('SYNC_CONFLICT')
    expect(error.details?.['paths']).toEqual(['a.txt'])
    expect(error.details?.['conflicts']).toEqual([
      { path: 'a.txt', kind: 'both-changed', sides: ['local', 'remote'] },
    ])
    expect(error.details?.['nextStep']).toContain('--keep-local')
    expect(error.message).toContain('a.txt')
    expect(await readFile(join(localRoot, 'a.txt'), 'utf8')).toBe('local edit')
  })

  it('shows the same conflict in sync diff instead of saying no changes', async () => {
    const { context } = await setup({
      baseline: 'original',
      local: 'local edit',
      remote: 'box',
    })

    const view = await runSyncDiff(context, { cliRules: [], pause: async () => {} })
    expect(view.conflicts).toEqual([
      {
        kind: 'both-changed',
        path: 'a.txt',
        relatedPaths: ['a.txt'],
        sides: ['local', 'remote'],
      },
    ])
    const rendered = renderSyncPlan(view)
    expect(rendered).toContain('! conflict both-changed a.txt (changed: local, remote)')
    expect(rendered).not.toContain('No changes.')
  })

  it('--keep-local leaves the local edit and reports it as a kept conflict', async () => {
    const { context, localRoot } = await setup({
      baseline: 'original',
      local: 'local edit',
      remote: 'box',
    })

    const view = await runSyncApply(context, 'pull', { ...options, keepLocal: true })

    expect(view.applied).toBe(false)
    expect(view.pulledFiles).toEqual([])
    expect(view.conflicts.map((conflict) => conflict.path)).toEqual(['a.txt'])
    expect(await readFile(join(localRoot, 'a.txt'), 'utf8')).toBe('local edit')
    expect(renderSyncApplied(view)).toContain('Kept local: a.txt')
  })

  it('--overwrite-local is the explicit way to take the box copy', async () => {
    const { context, localRoot } = await setup({
      baseline: 'original',
      local: 'local edit',
      remote: 'box',
    })

    const view = await runSyncApply(context, 'pull', { ...options, overwriteLocal: true })

    expect(view.conflicts).toEqual([])
    expect(view.pulledFiles).toEqual(['a.txt'])
    expect(view.baselineUpdated).toBe(true)
    expect(await readFile(join(localRoot, 'a.txt'), 'utf8')).toBe('box')
  })

  it('leaves a local edit alone when the box did not change that path', async () => {
    const { context, localRoot, requests } = await setup({
      baseline: 'original',
      local: 'local edit',
      remote: 'original',
    })

    const view = await runSyncApply(context, 'pull', options)

    expect(view.conflicts).toEqual([])
    expect(view.pulledFiles).toEqual([])
    expect(await readFile(join(localRoot, 'a.txt'), 'utf8')).toBe('local edit')
    expect(requests.some((request) => request.path.endsWith('/source/cas/pull'))).toBe(false)
  })

  it('still pulls a box change when the local copy matches the baseline', async () => {
    const { context, localRoot } = await setup({
      baseline: 'original',
      local: 'original',
      remote: 'box',
    })

    const view = await runSyncApply(context, 'pull', options)

    expect(view.conflicts).toEqual([])
    expect(view.pulledFiles).toEqual(['a.txt'])
    expect(view.baselineUpdated).toBe(true)
    expect(await readFile(join(localRoot, 'a.txt'), 'utf8')).toBe('box')
  })

  it('refuses a first pull with no baseline that would replace a local file', async () => {
    const { context, localRoot } = await setup({
      baseline: null,
      local: 'local edit',
      remote: 'box',
    })

    const error = await runFailure(runSyncApply(context, 'pull', options))

    expect(error.code).toBe('SYNC_CONFLICT')
    expect(error.details?.['paths']).toEqual(['a.txt'])
    expect(error.message).toContain('a.txt')
    expect(await readFile(join(localRoot, 'a.txt'), 'utf8')).toBe('local edit')
  })

  it('--overwrite-local is required to replace a local file on a first pull', async () => {
    const { context, localRoot } = await setup({
      baseline: null,
      local: 'local edit',
      remote: 'box',
    })

    const view = await runSyncApply(context, 'pull', { ...options, overwriteLocal: true })

    expect(view.conflicts).toEqual([])
    expect(view.pulledFiles).toEqual(['a.txt'])
    expect(view.baselineUpdated).toBe(true)
    expect(await readFile(join(localRoot, 'a.txt'), 'utf8')).toBe('box')
  })

  it('--keep-local keeps a first-pull conflict', async () => {
    const { context, localRoot } = await setup({
      baseline: null,
      local: 'local edit',
      remote: 'box',
    })

    const view = await runSyncApply(context, 'pull', { ...options, keepLocal: true })

    expect(view.pulledFiles).toEqual([])
    expect(view.conflicts.map((conflict) => conflict.path)).toEqual(['a.txt'])
    expect(await readFile(join(localRoot, 'a.txt'), 'utf8')).toBe('local edit')
  })

  it('ignores a box change to a path the local ignore rules keep out of sync', async () => {
    const { context, localRoot } = await setup({
      baseline: 'original',
      local: 'original',
      remote: 'box',
    })
    await writeFile(join(localRoot, '.gitignore'), 'a.txt\n')

    const view = await runSyncApply(context, 'pull', options)

    expect(view.conflicts).toEqual([])
    expect(view.pulledFiles).toEqual([])
    expect(await readFile(join(localRoot, 'a.txt'), 'utf8')).toBe('original')
  })
})

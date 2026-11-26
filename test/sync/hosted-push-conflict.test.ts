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
import { OcboxError } from '../../src/errors/index.js'
import { createCasTransport } from '../../src/providers/ocbox/cas.js'
import { cliRules } from '../../src/sync/ignore-rules.js'
import { runSyncApply, type SyncApplyOptions, type SyncContext } from '../../src/sync/service.js'
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

async function contextFor(origin: string, localRoot: string): Promise<SyncContext> {
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
    stateDirectory: join(dirname(localRoot), 'state'),
    localRoot,
    remoteRoot: join(dirname(localRoot), 'remote'),
    casTransport: createCasTransport(api, HOSTED_SESSION),
  }
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

describe('hosted push conflict', () => {
  it('names the locally changed path, the changed sides and the exclude way out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocbox-hosted-push-conflict-'))
    roots.push(root)
    const localRoot = join(root, 'local')
    await mkdir(localRoot)
    await writeFile(join(localRoot, 'a.txt'), 'original')

    const fastBodies: Record<string, unknown>[] = []
    let fastRefuses = true
    const { origin } = await serve((request, response) => {
      if (request.path.endsWith('/source/cas/check')) {
        json(response, {
          version: 3,
          state: 'changed',
          changedPaths: ['a.txt'],
          changedCount: 1,
          editedPaths: ['a.txt'],
          editedCount: 1,
          replayed: false,
        })
        return
      }
      if (request.path.endsWith('/source/cas/fast')) {
        fastBodies.push(request.body)
        if (fastRefuses) {
          json(
            response,
            {
              error: {
                code: 'SYNC_CONFLICT',
                message: 'Source sync conflicts with the workspace; resolve it and retry',
                reason: 'path_conflict',
              },
            },
            409,
          )
          return
        }
        json(response, {
          version: 3,
          state: 'applied',
          fingerprint: request.body['fingerprint'],
          missing: [],
          writtenFiles: 0,
          linkedFiles: 0,
          removedFiles: 0,
          fetchedBlobs: 0,
          fetchedBytes: 0,
          replayed: false,
        })
        return
      }
      if (request.path.endsWith('/source/cas/plan')) {
        json(response, {
          version: 2,
          planId: `casdo_${'a'.repeat(30)}`,
          state: 'uploading',
          expiresAt: Date.now() + 60_000,
          replayed: false,
          missing: [],
        })
        return
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
        return
      }
      return json(response, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
    })
    const context = await contextFor(origin, localRoot)

    // The first push establishes the last pushed tree and the baseline.
    await runSyncApply(context, 'push', options)
    await writeFile(join(localRoot, 'a.txt'), 'local edit')

    const error = await runFailure(runSyncApply(context, 'push', options))
    expect(error.code).toBe('SYNC_CONFLICT')
    expect(error.details?.['paths']).toEqual(['a.txt'])
    expect(error.details?.['conflicts']).toEqual([
      { path: 'a.txt', kind: 'both-changed', sides: ['local', 'remote'] },
    ])
    expect(error.details?.['nextStep']).toContain("--exclude 'a.txt'")
    expect(error.message).toContain('a.txt')
    fastRefuses = false

    // Following the named way out skips the path instead of deleting it from
    // the box, so the push succeeds without overwriting either side.
    const view = await runSyncApply(context, 'push', {
      ...options,
      cliRules: cliRules(['a.txt']),
    })
    expect(view.applied).toBe(true)
    const lastFast = fastBodies.at(-1) ?? {}
    expect(lastFast['files']).toEqual([])
    expect(lastFast['deletedPaths']).toEqual([])
    expect(await readFile(join(localRoot, 'a.txt'), 'utf8')).toBe('local edit')
  })
})

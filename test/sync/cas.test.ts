import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CAS_LIMITS,
  casHash,
  validateCasPages,
  type CasResult,
  type CasTransport,
} from '../../src/sync/cas-contract.js'
import { buildCasSnapshot, readCasState, writeCasState } from '../../src/sync/cas-snapshot.js'
import { syncCasSnapshot } from '../../src/sync/cas-transfer.js'
import { cliRules, loadIgnoreRuleGroups } from '../../src/sync/ignore-rules.js'
import { scanSourceManifest } from '../../src/sync/manifest.js'
import { casRefusal } from '../../src/providers/ocbox/cas.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cas-test-'))
  roots.push(root)
  const source = join(root, 'source'),
    cache = join(root, 'cache')
  await mkdir(source)
  await mkdir(cache)
  const build = async (previous?: Awaited<ReturnType<typeof buildCasSnapshot>>) =>
    buildCasSnapshot(source, cache, await scanSourceManifest(source), previous)
  return { root, source, cache, build }
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const baseReceipt: CasResult = {
  version: 2,
  planId: `casdo_${'a'.repeat(30)}`,
  state: 'uploading',
  expiresAt: Date.now() + 100_000,
  replayed: false,
}

describe('CAS snapshots and transfer', () => {
  it('uses canonical page hashes, file modes, empty files, bundles and bounded pages', async () => {
    const { source, cache, build } = await setup()
    await writeFile(join(source, 'a'), 'one')
    await chmod(join(source, 'a'), 0o755)
    await writeFile(join(source, 'b'), 'two')
    await writeFile(join(source, 'empty'), '')
    for (let i = 0; i < 520; i++) await mkdir(join(source, `dir${i}`))
    const snapshot = await build()
    expect(snapshot.pages).toHaveLength(2)
    validateCasPages(snapshot.manifest, snapshot.pages)
    const files = snapshot.pages.flatMap((p) => p.files),
      a = files.find((f) => f.path === 'a'),
      b = files.find((f) => f.path === 'b')
    expect(a).toMatchObject({
      mode: 493,
      hash: digest(Buffer.from('one')),
      parts: [{ offset: 0, size: 3 }],
    })
    expect(b).toMatchObject({ parts: [{ offset: 3, size: 3 }] })
    expect(files.find((f) => f.path === 'empty')).toMatchObject({ parts: [] })
    const blob = snapshot.pages[0]?.blobs[0]
    expect(await readFile(join(cache, blob?.hash ?? ''))).toEqual(Buffer.from('onetwo'))
    expect(casHash({ z: [{ y: 1, a: 2 }], a: 0 })).toBe(casHash({ a: 0, z: [{ a: 2, y: 1 }] }))
  })

  it('keeps unchanged bundle slices and makes precisely three blobs for three small edits', async () => {
    const { source, build } = await setup()
    for (let i = 0; i < 6; i++) await writeFile(join(source, `file${i}`), `original${i}`)
    const first = await build()
    for (let i = 0; i < 3; i++) await writeFile(join(source, `file${i}`), `changed${i}`)
    const second = await build(first)
    expect(first.pages[0]?.blobs).toHaveLength(1)
    expect(second.pages[0]?.blobs).toHaveLength(4)
    expect(second.pages[0]?.files.slice(3)).toEqual(first.pages[0]?.files.slice(3))
    expect(
      second.pages[0]?.blobs.filter((b) => b.hash !== first.pages[0]?.blobs[0]?.hash),
    ).toHaveLength(3)
  })

  it('splits a large file into 16 MiB parts and verifies content rather than trusting cache metadata', async () => {
    const { source, cache, build } = await setup()
    const bytes = Buffer.alloc(CAS_LIMITS.partBytes + 1, 7)
    await writeFile(join(source, 'large'), bytes)
    const first = await build()
    expect(first.pages[0]?.blobs.map((b) => b.size).sort((a, b) => b - a)).toEqual([
      CAS_LIMITS.partBytes,
      1,
    ])
    const blob = first.pages[0]?.blobs[0]
    await writeFile(join(cache, blob?.hash ?? ''), 'corrupt')
    const rebuilt = await build(first)
    expect(rebuilt.manifest.pageHashes).toEqual(first.manifest.pageHashes)
    expect(digest(await readFile(join(cache, blob?.hash ?? '')))).toBe(blob?.hash)
  })

  it('reuses CLI ignore precedence and unoverrideable cache/state exclusions', async () => {
    const { source } = await setup()
    for (const name of ['.git', 'node_modules', '.cache', 'state']) {
      await mkdir(join(source, name))
      await writeFile(join(source, name, 'hidden'), 'hidden')
    }
    await writeFile(join(source, '.gitignore'), '*.txt\n')
    await writeFile(join(source, '.opencloudboxignore'), '!keep.txt\n')
    await writeFile(join(source, 'skip.txt'), 'skip')
    await writeFile(join(source, 'keep.txt'), 'keep')
    const groups = await loadIgnoreRuleGroups(
      source,
      cliRules([], ['.git/**', 'node_modules/**', '.cache/**', 'state/**']),
    )
    const scan = await scanSourceManifest(source, {
      ignoreRuleGroups: groups,
      excludePaths: ['state'],
    })
    expect(scan.entries.filter((f) => !f.exclusionReason).map((f) => f.path)).toEqual([
      '.gitignore',
      '.opencloudboxignore',
      'keep.txt',
    ])
    expect(scan.entries.some((f) => f.path.startsWith('state'))).toBe(false)
    await symlink(join(source, 'keep.txt'), join(source, 'link'))
    expect((await scanSourceManifest(source)).blocked).toContainEqual({
      path: 'link',
      reason: 'symlink',
    })
  })

  it('rejects unsigned state tampering and never saves upload capabilities', async () => {
    const { root, source, build } = await setup()
    await writeFile(join(source, 'a'), 'value')
    const snapshot = await build(),
      path = join(root, 'state.json')
    await writeCasState(path, snapshot)
    expect(await readCasState(path)).toEqual(snapshot)
    expect(await readFile(path, 'utf8')).not.toMatch(/url|Bearer|cacheDirectory/)
    const bad = structuredClone(snapshot)
    bad.pages[0]?.files.splice(0)
    await writeFile(path, JSON.stringify(bad))
    await expect(readCasState(path)).rejects.toMatchObject({ code: 'SYNC_INTEGRITY' })
  })

  it('uploads opaque capability URLs without auth or redirects and polls the matching plan', async () => {
    const { source, cache, build } = await setup()
    await writeFile(join(source, 'a'), 'value')
    const snapshot = await build(),
      blob = snapshot.pages[0]?.blobs[0]
    if (!blob) throw new Error('Missing test blob')
    let applied = 0,
      puts = 0
    const transport: CasTransport = {
      scope: 'test',
      sessionId: 'sesdo_test',
      async call(request) {
        if (request.operation === 'plan')
          return {
            ...baseReceipt,
            missing: [{ ...blob, url: 'https://api.opencloudbox.dev/opaque?cap=hidden' }],
          }
        applied++
        return { ...baseReceipt, state: applied === 1 ? 'pending' : 'succeeded' }
      },
    }
    const result = await syncCasSnapshot(snapshot, cache, transport, {
      pause: async () => {},
      fetcher: async (input, init) => {
        puts++
        expect(input).toBe('https://api.opencloudbox.dev/opaque?cap=hidden')
        expect(init?.headers).toBeUndefined()
        expect(init?.credentials).toBe('omit')
        expect(init?.redirect).toBe('error')
        expect(digest(init?.body as Buffer)).toBe(blob?.hash)
        return new Response(null, { status: 200 })
      },
    })
    expect(result.uploadedBlobs).toBe(1)
    expect(puts).toBe(1)
    expect(applied).toBe(2)
  })

  it('rejects undeclared blobs, mismatched receipts, unsafe URLs, refusals and timeout', async () => {
    const { source, cache, build } = await setup()
    await writeFile(join(source, 'a'), 'value')
    const snapshot = await build(),
      blob = snapshot.pages[0]?.blobs[0]
    if (!blob) throw new Error('Missing test blob')
    const transport: CasTransport = {
      scope: 'test',
      sessionId: 'sesdo_test',
      call: async () => ({
        ...baseReceipt,
        missing: [{ hash: 'b'.repeat(64), size: 1, url: 'https://api.opencloudbox.dev/x' }],
      }),
    }
    await expect(syncCasSnapshot(snapshot, cache, transport)).rejects.toMatchObject({
      code: 'SYNC_INTEGRITY',
    })
    transport.call = async () => ({
      ...baseReceipt,
      missing: [{ ...blob, url: 'file:///private' }],
    })
    await expect(syncCasSnapshot(snapshot, cache, transport)).rejects.toMatchObject({
      code: 'SYNC_INTEGRITY',
    })
    transport.call = async (r) => ({
      ...baseReceipt,
      planId: r.operation === 'plan' ? baseReceipt.planId : `casdo_${'b'.repeat(30)}`,
    })
    await expect(syncCasSnapshot(snapshot, cache, transport)).rejects.toMatchObject({
      code: 'SYNC_INTEGRITY',
    })
    transport.call = async () => ({ ...baseReceipt, state: 'failed', reason: 'path_conflict' })
    await expect(syncCasSnapshot(snapshot, cache, transport)).rejects.toMatchObject({
      code: 'SYNC_CONFLICT',
    })
    let clock = 0
    transport.call = async (r) => ({
      ...baseReceipt,
      state: r.operation === 'plan' ? 'uploading' : 'pending',
    })
    await expect(
      syncCasSnapshot(snapshot, cache, transport, {
        now: () => clock,
        pause: async () => {
          clock += CAS_LIMITS.applyTimeoutMs
        },
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
    expect(casRefusal(403).code).toBe('AUTH_FORBIDDEN')
  })
})

// Orchestration checks exercise real source/cache/checkpoint files across calls.
describe('CAS push checkpoints', () => {
  it('resumes identical source, gives edits a new identity and does not refresh plan age on retries', async () => {
    const { root, source } = await setup()
    const { ProjectIdSchema, SessionIdSchema } = await import('../../src/domain/ids.js')
    const { runSyncApply } = await import('../../src/sync/service.js')
    const { casError } = await import('../../src/sync/cas-snapshot.js')
    const { readdir } = await import('node:fs/promises')
    await writeFile(join(source, 'a'), 'original')
    const ids: string[] = []
    let failApply = true
    const context = {
      providerName: 'ocbox',
      projectId: ProjectIdSchema.parse('11111111-1111-4111-8111-111111111111'),
      sessionId: SessionIdSchema.parse('22222222-2222-4222-8222-222222222222'),
      localRoot: source,
      remoteRoot: join(root, 'remote'),
      stateDirectory: join(root, 'state'),
      casTransport: {
        scope: 'test',
        sessionId: 'sesdo_test',
        async call(request: Parameters<CasTransport['call']>[0]): Promise<CasResult> {
          if (request.operation === 'plan') {
            ids.push(request.manifest.syncId)
            return baseReceipt
          }
          if (failApply) throw casError('SYNC_FAILED', 'Interrupted')
          return { ...baseReceipt, state: 'succeeded' }
        },
      },
    }
    const options = {
      cliRules: [],
      delete: false,
      yes: false,
      interactive: false,
      confirm: async () => false,
    }
    await expect(runSyncApply(context, 'push', options)).rejects.toMatchObject({
      code: 'SYNC_FAILED',
    })
    const names = await readdir(context.stateDirectory, { recursive: true })
    const pendingName = names.find((name) => name.endsWith('pending.json'))
    if (!pendingName) throw new Error('Missing checkpoint')
    const pendingPath = join(context.stateDirectory, pendingName)
    const first = await readCasState(pendingPath)
    if (!first) throw new Error('Missing snapshot')
    await expect(runSyncApply(context, 'push', options)).rejects.toMatchObject({
      code: 'SYNC_FAILED',
    })
    expect(ids[1]).toBe(ids[0])
    expect((await readCasState(pendingPath))?.createdAt).toBe(first.createdAt)
    await writeFile(join(source, 'a'), 'edited')
    await expect(runSyncApply(context, 'push', options)).rejects.toMatchObject({
      code: 'SYNC_FAILED',
    })
    expect(ids[2]).not.toBe(ids[1])
    const pending = await readCasState(pendingPath)
    if (!pending) throw new Error('Missing snapshot')
    pending.createdAt = Date.now() - 46 * 60_000
    await writeCasState(pendingPath, pending)
    failApply = false
    await runSyncApply(context, 'push', options)
    expect(ids[3]).not.toBe(ids[2])
    await expect(readFile(pendingPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('clears a terminal refused plan so a later retry can use a fresh plan', async () => {
    const { root, source } = await setup()
    const { ProjectIdSchema, SessionIdSchema } = await import('../../src/domain/ids.js')
    const { runSyncApply } = await import('../../src/sync/service.js')
    const { CasPlanRefused } = await import('../../src/providers/ocbox/cas.js')
    await writeFile(join(source, 'a'), 'original')
    const ids: string[] = []
    let refused = true
    const context = {
      providerName: 'ocbox',
      projectId: ProjectIdSchema.parse('11111111-1111-4111-8111-111111111111'),
      sessionId: SessionIdSchema.parse('22222222-2222-4222-8222-222222222222'),
      localRoot: source,
      remoteRoot: join(root, 'remote'),
      stateDirectory: join(root, 'state'),
      casTransport: {
        scope: 'test',
        sessionId: 'sesdo_test',
        async call(request: Parameters<CasTransport['call']>[0]): Promise<CasResult> {
          if (request.operation === 'plan') {
            ids.push(request.manifest.syncId)
            return baseReceipt
          }
          if (refused) throw new CasPlanRefused(casRefusal(409, 'plan_expired'))
          return { ...baseReceipt, state: 'succeeded' }
        },
      },
    }
    const options = {
      cliRules: [],
      delete: false,
      yes: false,
      interactive: false,
      confirm: async () => false,
    }
    await expect(runSyncApply(context, 'push', options)).rejects.toMatchObject({
      code: 'SYNC_FAILED',
    })
    refused = false
    await runSyncApply(context, 'push', options)
    expect(ids[1]).not.toBe(ids[0])
  })
})

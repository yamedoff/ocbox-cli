import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OperationIdSchema,
  ProjectIdSchema,
  SessionIdSchema,
  UtcTimestampSchema,
} from '../../src/contracts.js'
import { createVerifiedBaseline } from '../../src/sync/baseline.js'
import { SyncBaselineStore, SyncBaselineStoreError } from '../../src/sync/baseline-store.js'
import { scanSourceManifest } from '../../src/sync/manifest.js'

const roots: string[] = []
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ocbox-baseline-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

const PROJECT_ID = ProjectIdSchema.parse('11111111-1111-4111-8111-111111111111')
const SESSION_ID = SessionIdSchema.parse('22222222-2222-4222-8222-222222222222')
const TIMESTAMP = UtcTimestampSchema.parse('2026-09-10T00:00:00.000Z')

async function baselineFor(source: string) {
  const manifest = await scanSourceManifest(source)
  return createVerifiedBaseline(manifest, TIMESTAMP)
}

describe('sync baseline store', () => {
  it('round-trips verified evidence with relative paths only', async () => {
    const state = await root()
    const source = await root()
    await writeFile(join(source, 'value.txt'), 'content')
    const baseline = await baselineFor(source)
    const store = new SyncBaselineStore(state, PROJECT_ID, SESSION_ID)

    expect(await store.load()).toBeNull()
    await store.save(baseline)
    const loaded = await store.load()
    expect(loaded).toEqual(baseline)
    expect(JSON.stringify(loaded)).not.toContain(source)
  })

  it('fails closed on a corrupt baseline document', async () => {
    const state = await root()
    const store = new SyncBaselineStore(state, PROJECT_ID, SESSION_ID)
    await store.save(await baselineFor(await root()))
    const path = join(state, 'sync', PROJECT_ID, SESSION_ID, 'baseline.json')
    await writeFile(path, '{"schemaVersion":1,')
    await expect(store.load()).rejects.toBeInstanceOf(SyncBaselineStoreError)
    await expect(store.load()).rejects.toMatchObject({ code: 'CORRUPT_BASELINE' })
  })

  it('rejects a tampered checksum instead of trusting it', async () => {
    const state = await root()
    const source = await root()
    await writeFile(join(source, 'value.txt'), 'content')
    const baseline = await baselineFor(source)
    const path = join(state, 'sync', PROJECT_ID, SESSION_ID, 'baseline.json')
    await new SyncBaselineStore(state, PROJECT_ID, SESSION_ID).save(baseline)
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, JSON.stringify({ ...parsed, snapshotSha256: 'a'.repeat(64) }))
    await expect(new SyncBaselineStore(state, PROJECT_ID, SESSION_ID).load()).rejects.toMatchObject(
      {
        code: 'CORRUPT_BASELINE',
      },
    )
  })

  it('promotes a pending intent into the verified baseline without nesting', async () => {
    const state = await root()
    const source = await root()
    await writeFile(join(source, 'value.txt'), 'content')
    const baseline = await baselineFor(source)
    const store = new SyncBaselineStore(state, PROJECT_ID, SESSION_ID)
    const pending = {
      schemaVersion: 1 as const,
      operationId: OperationIdSchema.parse('33333333-3333-4333-8333-333333333333'),
      mode: 'push' as const,
      targetSide: 'remote' as const,
      baseline,
    }

    expect(await store.loadPending()).toBeNull()
    await store.savePending(pending)
    expect(await store.loadPending()).toEqual(pending)
    expect(await store.load()).toBeNull()

    await store.promotePending()
    expect(await store.load()).toEqual(baseline)
    expect(await store.loadPending()).toBeNull()
  })

  it('discards a pending intent without touching the verified baseline', async () => {
    const state = await root()
    const source = await root()
    await writeFile(join(source, 'value.txt'), 'content')
    const baseline = await baselineFor(source)
    const store = new SyncBaselineStore(state, PROJECT_ID, SESSION_ID)
    await store.save(baseline)
    await store.savePending({
      schemaVersion: 1,
      operationId: OperationIdSchema.parse('44444444-4444-4444-8444-444444444444'),
      mode: 'pull',
      targetSide: 'local',
      baseline,
    })
    await store.clearPending()
    expect(await store.loadPending()).toBeNull()
    expect(await store.load()).toEqual(baseline)
  })

  it('fails closed on a corrupt pending document', async () => {
    const state = await root()
    const store = new SyncBaselineStore(state, PROJECT_ID, SESSION_ID)
    await store.save(await baselineFor(await root()))
    const path = join(state, 'sync', PROJECT_ID, SESSION_ID, 'pending-baseline.json')
    await writeFile(path, '{"schemaVersion":1,')
    await expect(store.loadPending()).rejects.toMatchObject({ code: 'CORRUPT_BASELINE' })
  })
})

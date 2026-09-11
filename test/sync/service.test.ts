import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectIdSchema, SessionIdSchema, UtcTimestampSchema } from '../../src/contracts.js'
import { OcboxError } from '../../src/errors/index.js'
import { createVerifiedBaseline } from '../../src/sync/baseline.js'
import { cliRules } from '../../src/sync/ignore-rules.js'
import { scanSourceManifest } from '../../src/sync/manifest.js'
import {
  type SyncContext,
  type SyncApplyOptions,
  runSyncApply,
  runSyncDiff,
  runSyncRecover,
} from '../../src/sync/service.js'
import { ExclusiveFileLock } from '../../src/state/exclusive-file-lock.js'

const roots: string[] = []
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ocbox-sync-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

const PROJECT_ID = ProjectIdSchema.parse('11111111-1111-4111-8111-111111111111')
const SESSION_ID = SessionIdSchema.parse('22222222-2222-4222-8222-222222222222')

async function context(localRoot: string, remoteRoot: string): Promise<SyncContext> {
  const stateDirectory = await root()
  return {
    providerName: 'fake',
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    stateDirectory,
    localRoot,
    remoteRoot,
  }
}

function applyOptions(overrides: Partial<SyncApplyOptions> = {}): SyncApplyOptions {
  return {
    cliRules: [],
    delete: false,
    yes: false,
    interactive: false,
    confirm: async () => false,
    ...overrides,
  }
}

async function pair(): Promise<{ context: SyncContext; local: string; remote: string }> {
  const local = await root()
  const remote = await root()
  return { context: await context(local, remote), local, remote }
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

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('sync service', () => {
  it('applies a first push, persists a baseline, and is idempotent', async () => {
    const { context: sync, local, remote } = await pair()
    await writeFile(join(local, 'value.txt'), 'content')
    await mkdir(join(local, 'nested'))
    await writeFile(join(local, 'nested', 'deep.txt'), 'deep')

    const first = await runSyncApply(sync, 'push', applyOptions())
    expect(first.applied).toBe(true)
    expect(first.firstSync).toBe(true)
    expect(await readFile(join(remote, 'value.txt'), 'utf8')).toBe('content')
    expect(await readFile(join(remote, 'nested', 'deep.txt'), 'utf8')).toBe('deep')

    const second = await runSyncApply(sync, 'push', applyOptions())
    expect(second.applied).toBe(false)
    expect(second.operations).toEqual([])
  })

  it('keeps diff non-mutating while reporting a local modification', async () => {
    const { context: sync, local, remote } = await pair()
    await writeFile(join(local, 'value.txt'), 'v1')
    await runSyncApply(sync, 'push', applyOptions())
    await writeFile(join(local, 'value.txt'), 'v2')

    const diff = await runSyncDiff(sync, { cliRules: [] })
    expect(diff.modifications).toEqual([{ side: 'local', kind: 'modification', path: 'value.txt' }])
    expect(await readFile(join(remote, 'value.txt'), 'utf8')).toBe('v1')
    expect(await readFile(join(local, 'value.txt'), 'utf8')).toBe('v2')
  })

  it('pulls a remote-only modification into the local target', async () => {
    const { context: sync, local, remote } = await pair()
    await writeFile(join(local, 'value.txt'), 'v1')
    await runSyncApply(sync, 'push', applyOptions())
    await writeFile(join(remote, 'value.txt'), 'remote-v2')

    const result = await runSyncApply(sync, 'pull', applyOptions())
    expect(result.applied).toBe(true)
    expect(result.modifications).toEqual([
      { side: 'remote', kind: 'modification', path: 'value.txt' },
    ])
    expect(await readFile(join(local, 'value.txt'), 'utf8')).toBe('remote-v2')
  })

  it('fails closed on a both-sides change and preserves both copies', async () => {
    const { context: sync, local, remote } = await pair()
    await writeFile(join(local, 'value.txt'), 'v1')
    await runSyncApply(sync, 'push', applyOptions())
    await writeFile(join(local, 'value.txt'), 'local-change')
    await writeFile(join(remote, 'value.txt'), 'remote-change')

    const error = await runFailure(runSyncApply(sync, 'push', applyOptions()))
    expect(error.code).toBe('SYNC_CONFLICT')
    expect(await readFile(join(local, 'value.txt'), 'utf8')).toBe('local-change')
    expect(await readFile(join(remote, 'value.txt'), 'utf8')).toBe('remote-change')
  })

  it('requires --delete and either confirmation or --yes for deletions', async () => {
    const { context: sync, local, remote } = await pair()
    await writeFile(join(local, 'remove.txt'), 'remove me')
    await writeFile(join(local, 'keep.txt'), 'keep')
    await runSyncApply(sync, 'push', applyOptions())
    await rm(join(local, 'remove.txt'))

    const refused = await runFailure(runSyncApply(sync, 'push', applyOptions()))
    expect(refused.code).toBe('SYNC_CONFLICT')
    expect(await readFile(join(remote, 'remove.txt'), 'utf8')).toBe('remove me')

    const nonTty = await runFailure(
      runSyncApply(sync, 'push', applyOptions({ delete: true, interactive: false })),
    )
    expect(nonTty.code).toBe('SYNC_CONFLICT')

    const declined = await runFailure(
      runSyncApply(
        sync,
        'push',
        applyOptions({ delete: true, interactive: true, confirm: async () => false }),
      ),
    )
    expect(declined.code).toBe('SYNC_CONFLICT')

    const applied = await runSyncApply(sync, 'push', applyOptions({ delete: true, yes: true }))
    expect(applied.applied).toBe(true)
    await expect(readFile(join(remote, 'remove.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(remote, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('never transfers built-in secret exclusions but reports them from diff', async () => {
    const { context: sync, local, remote } = await pair()
    await writeFile(join(local, '.env.local'), 'SECRET=1')
    await mkdir(join(local, 'node_modules'))
    await writeFile(join(local, 'node_modules', 'dep.js'), 'dep')
    await writeFile(join(local, 'app.js'), 'app')

    const diff = await runSyncDiff(sync, { cliRules: [] })
    expect(diff.excluded.map((entry) => entry.reason)).toContain('secret-environment')
    expect(diff.excluded.map((entry) => entry.reason)).toContain('dependency-cache')

    await runSyncApply(sync, 'push', applyOptions())
    await expect(readFile(join(remote, '.env.local'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(remote, 'node_modules', 'dep.js'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readFile(join(remote, 'app.js'), 'utf8')).toBe('app')
  })

  it('round-trips binary content byte for byte', async () => {
    const { context: sync, local, remote } = await pair()
    const bytes = Uint8Array.of(0, 255, 1, 128, 10, 0, 42)
    await writeFile(join(local, 'blob.bin'), bytes)
    await runSyncApply(sync, 'push', applyOptions())
    expect(await readFile(join(remote, 'blob.bin'))).toEqual(Buffer.from(bytes))

    const next = Uint8Array.of(9, 8, 7, 0, 255)
    await writeFile(join(remote, 'blob.bin'), next)
    await runSyncApply(sync, 'pull', applyOptions())
    expect(hash(await readFile(join(local, 'blob.bin')))).toBe(hash(next))
  })

  it('fails closed on a symlink instead of dereferencing it', async () => {
    const { context: sync, local, remote } = await pair()
    const outside = await root()
    await writeFile(join(outside, 'secret.txt'), 'outside')
    await symlink(outside, join(local, 'link'), 'junction')
    const error = await runFailure(runSyncApply(sync, 'push', applyOptions()))
    expect(error.code).toBe('SYNC_CONFLICT')
    await expect(readFile(join(remote, 'secret.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when the target root is not a directory', async () => {
    const local = await root()
    const parent = await root()
    const remote = join(parent, 'target-file')
    await writeFile(remote, 'occupied')
    const sync = await context(local, remote)
    await writeFile(join(local, 'value.txt'), 'v1')
    const error = await runFailure(runSyncApply(sync, 'push', applyOptions()))
    expect(error.code).toBe('SYNC_CONFLICT')
    expect(await readFile(remote, 'utf8')).toBe('occupied')
  })

  it('refuses a first pull into a non-empty local target', async () => {
    const { context: sync, local, remote } = await pair()
    await writeFile(join(remote, 'value.txt'), 'remote')
    await writeFile(join(local, 'preexisting.txt'), 'local')
    const error = await runFailure(runSyncApply(sync, 'pull', applyOptions()))
    expect(error.code).toBe('SYNC_CONFLICT')
  })

  it('fails closed for recovery-required state until recovery is explicit', async () => {
    const { context: sync, local, remote } = await pair()
    await writeFile(join(local, 'value.txt'), 'v1')
    await runSyncApply(sync, 'push', applyOptions())
    const state = join(dirname(remote), `.${basename(remote)}.ocbox-sync-state`)
    await writeFile(
      join(state, 'journal.json'),
      JSON.stringify({
        schemaVersion: 1,
        operationId: '00000000-0000-0000-0000-000000000000',
        stage: 'staged',
        hadTarget: null,
        stagingDirectory: 'stage-00000000-0000-0000-0000-000000000000',
        backupDirectory: 'backup-00000000-0000-0000-0000-000000000000',
      }),
    )
    const error = await runFailure(runSyncApply(sync, 'push', applyOptions()))
    expect(error.code).toBe('SYNC_FAILED')

    const recovered = await runSyncRecover(sync)
    expect(recovered.recovered).toBe(true)
    const after = await runSyncApply(sync, 'push', applyOptions())
    expect(after.applied).toBe(false)
  })

  it('fails closed on a corrupt stored baseline', async () => {
    const { context: sync, local } = await pair()
    await writeFile(join(local, 'value.txt'), 'v1')
    await runSyncApply(sync, 'push', applyOptions())
    const baselinePath = join(sync.stateDirectory, 'sync', PROJECT_ID, SESSION_ID, 'baseline.json')
    await writeFile(baselinePath, '{"schemaVersion":1,')
    const error = await runFailure(runSyncApply(sync, 'push', applyOptions()))
    expect(error.code).toBe('SYNC_INTEGRITY')
  })

  it('applies CLI include rules without weakening built-ins', async () => {
    const { context: sync, local, remote } = await pair()
    await writeFile(join(local, 'debug.log'), 'log')
    const rules = cliRules(['*.log'])
    await runSyncApply(sync, 'push', applyOptions({ cliRules: rules }))
    await expect(readFile(join(remote, 'debug.log'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('applies a deletion after interactive confirmation', async () => {
    const { context: sync, local, remote } = await pair()
    await writeFile(join(local, 'remove.txt'), 'remove')
    await runSyncApply(sync, 'push', applyOptions())
    await rm(join(local, 'remove.txt'))

    const applied = await runSyncApply(
      sync,
      'push',
      applyOptions({ delete: true, interactive: true, confirm: async () => true }),
    )
    expect(applied.applied).toBe(true)
    await expect(readFile(join(remote, 'remove.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reconciles a pending baseline left after the target commit', async () => {
    const { context: sync, local } = await pair()
    const baselinePath = join(sync.stateDirectory, 'sync', PROJECT_ID, SESSION_ID, 'baseline.json')
    const pendingPath = join(
      sync.stateDirectory,
      'sync',
      PROJECT_ID,
      SESSION_ID,
      'pending-baseline.json',
    )

    await writeFile(join(local, 'value.txt'), 'v1')
    await runSyncApply(sync, 'push', applyOptions())
    const first = JSON.parse(await readFile(baselinePath, 'utf8')) as Record<string, unknown>

    await writeFile(join(local, 'value.txt'), 'v2')
    await runSyncApply(sync, 'push', applyOptions())
    const second = JSON.parse(await readFile(baselinePath, 'utf8')) as Record<string, unknown>

    // Simulate a crash between the target commit and baseline promotion: the
    // target already holds v2, but only the stale v1 baseline is persisted.
    await writeFile(baselinePath, JSON.stringify(first))
    await writeFile(
      pendingPath,
      JSON.stringify({
        schemaVersion: 1,
        operationId: '55555555-5555-4555-8555-555555555555',
        mode: 'push',
        targetSide: 'remote',
        baseline: second,
      }),
    )

    const retry = await runSyncApply(sync, 'push', applyOptions())
    expect(retry.applied).toBe(false)
    expect(JSON.parse(await readFile(baselinePath, 'utf8'))).toEqual(second)
    await expect(readFile(pendingPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discards a pending baseline whose target never reached the desired state', async () => {
    const { context: sync, local } = await pair()
    const baselinePath = join(sync.stateDirectory, 'sync', PROJECT_ID, SESSION_ID, 'baseline.json')
    const pendingPath = join(
      sync.stateDirectory,
      'sync',
      PROJECT_ID,
      SESSION_ID,
      'pending-baseline.json',
    )
    await writeFile(join(local, 'value.txt'), 'v1')
    await runSyncApply(sync, 'push', applyOptions())
    const first = JSON.parse(await readFile(baselinePath, 'utf8')) as Record<string, unknown>

    await writeFile(join(local, 'value.txt'), 'v2')
    const desired = createVerifiedBaseline(
      await scanSourceManifest(local),
      UtcTimestampSchema.parse('2026-09-10T00:00:00.000Z'),
    )
    await writeFile(
      pendingPath,
      JSON.stringify({
        schemaVersion: 1,
        operationId: '66666666-6666-4666-8666-666666666666',
        mode: 'push',
        targetSide: 'remote',
        baseline: desired,
      }),
    )

    const recovered = await runSyncRecover(sync)
    expect(recovered.recovered).toBe(true)
    expect(JSON.parse(await readFile(baselinePath, 'utf8'))).toEqual(first)
    await expect(readFile(pendingPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed on diff while a pending baseline is unreconciled', async () => {
    const { context: sync, local } = await pair()
    const baselinePath = join(sync.stateDirectory, 'sync', PROJECT_ID, SESSION_ID, 'baseline.json')
    const pendingPath = join(
      sync.stateDirectory,
      'sync',
      PROJECT_ID,
      SESSION_ID,
      'pending-baseline.json',
    )
    await writeFile(join(local, 'value.txt'), 'v1')
    await runSyncApply(sync, 'push', applyOptions())
    await writeFile(
      pendingPath,
      JSON.stringify({
        schemaVersion: 1,
        operationId: '77777777-7777-4777-8777-777777777777',
        mode: 'push',
        targetSide: 'remote',
        baseline: JSON.parse(await readFile(baselinePath, 'utf8')),
      }),
    )
    const error = await runFailure(runSyncDiff(sync, { cliRules: [] }))
    expect(error.code).toBe('SYNC_FAILED')
  })

  it('fails closed when a concurrent sync holds the Session lock', async () => {
    const { context: sync, local } = await pair()
    await writeFile(join(local, 'value.txt'), 'v1')
    const lock = new ExclusiveFileLock({
      timeoutMilliseconds: 0,
      createTimeoutError: () => new Error('sync-test-lock-timeout'),
      createCancelledError: () => new Error('sync-test-lock-cancelled'),
    })
    const path = join(sync.stateDirectory, 'sync', PROJECT_ID, SESSION_ID, 'sync.lock')
    await lock.withLock(path, undefined, async () => {
      const error = await runFailure(
        runSyncApply(sync, 'push', applyOptions({ lockTimeoutMilliseconds: 0 })),
      )
      expect(error.code).toBe('OPERATION_CONFLICT')
    })
  })
})

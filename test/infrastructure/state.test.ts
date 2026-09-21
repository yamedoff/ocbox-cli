import { mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectIdSchema, SandboxIdSchema, SessionIdSchema } from '../../src/domain/ids.js'
import {
  LocalStateStore,
  ProjectStateSchema,
  StateCorruptionError,
  StateLockCancelledError,
  StateLockTimeoutError,
} from '../../src/state/index.js'

const PROJECT_ID = ProjectIdSchema.parse('11111111-1111-4111-8111-111111111111')
const SESSION_ONE = SessionIdSchema.parse('22222222-2222-4222-8222-222222222222')
const SESSION_TWO = SessionIdSchema.parse('33333333-3333-4333-8333-333333333333')
const SANDBOX_ONE = SandboxIdSchema.parse('44444444-4444-4444-8444-444444444444')
const SANDBOX_TWO = SandboxIdSchema.parse('55555555-5555-4555-8555-555555555555')
const NOW = '2026-09-04T12:00:00.000Z'
const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), 'ocbox-state-')),
  )
  temporaryDirectories.push(directory)
  return directory
}

function stateFixture() {
  return ProjectStateSchema.parse({
    schemaVersion: 1,
    projectId: PROJECT_ID,
    activeSessionId: SESSION_TWO,
    sessions: {
      [SESSION_ONE]: {
        sessionId: SESSION_ONE,
        sandboxId: SANDBOX_ONE,
        providerSandboxId: 'provider-one',
        provider: 'acme-cloud',
        lastSafeManifest: {
          algorithm: 'sha256',
          digest: DIGEST_A,
          fileCount: 12,
          totalBytes: 4096,
          recordedAt: NOW,
        },
        lastSyncBaseline: null,
        updatedAt: NOW,
      },
      [SESSION_TWO]: {
        sessionId: SESSION_TWO,
        sandboxId: SANDBOX_TWO,
        providerSandboxId: 'provider-two',
        provider: 'acme-cloud',
        lastSafeManifest: null,
        lastSyncBaseline: {
          localManifestDigestSha256: DIGEST_A,
          remoteManifestDigestSha256: DIGEST_B,
          synchronizedAt: NOW,
        },
        updatedAt: NOW,
      },
    },
  })
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('LocalStateStore', () => {
  it('atomically persists many known Sessions and cleans lock/temp files', async () => {
    const directory = await temporaryDirectory()
    const store = new LocalStateStore(directory)
    const expected = stateFixture()

    await store.save(expected)

    expect(await store.load(PROJECT_ID)).toEqual(expected)
    expect((await readdir(directory)).filter((name) => /\.(?:lock|tmp\.)/.test(name))).toEqual([])
  })

  it('quarantines corrupt state without exposing its content', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, `${PROJECT_ID}.json`), '{"accessToken":"do-not-echo"}', 'utf8')
    const store = new LocalStateStore(directory)

    await expect(store.load(PROJECT_ID)).rejects.toBeInstanceOf(StateCorruptionError)
    const names = await readdir(directory)
    expect(names.some((name) => name.includes('.json.corrupt.'))).toBe(true)
    expect(names).not.toContain(`${PROJECT_ID}.json`)
  })

  it('serializes concurrent stale-lock recovery without losing updates', async () => {
    const directory = await temporaryDirectory()
    const store = new LocalStateStore(directory, { pollIntervalMilliseconds: 1 })
    await store.save(stateFixture())
    const lockPath = join(directory, `${PROJECT_ID}.lock`)
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999999, createdAtEpochMilliseconds: 0, nonce: 'dead' }),
    )
    const old = new Date(Date.now() - 60000)
    await utimes(lockPath, old, old)
    let updates = 0
    await Promise.all(
      Array.from({ length: 12 }, () =>
        store.update(PROJECT_ID, (state) => {
          expect(state).not.toBeNull()
          updates += 1
          return stateFixture()
        }),
      ),
    )
    expect(updates).toBe(12)
    expect(await readdir(directory)).toEqual([`${PROJECT_ID}.json`])
  })

  it('rejects an unvalidated project identifier before creating paths', async () => {
    const directory = await temporaryDirectory()
    const store = new LocalStateStore(directory)
    await expect(store.load('../escape' as typeof PROJECT_ID)).rejects.toThrow()
    expect(await readdir(directory)).toEqual([])
  })

  it('bounds live-owner contention and supports cancellation', async () => {
    const directory = await temporaryDirectory()
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, `${PROJECT_ID}.lock`),
      JSON.stringify({ pid: process.pid, createdAtEpochMilliseconds: Date.now(), nonce: 'live' }),
      'utf8',
    )
    const store = new LocalStateStore(directory, {
      lockTimeoutMilliseconds: 15,
      pollIntervalMilliseconds: 2,
      staleLockMilliseconds: 60_000,
    })
    await expect(store.load(PROJECT_ID)).rejects.toBeInstanceOf(StateLockTimeoutError)

    const controller = new AbortController()
    controller.abort()
    await expect(store.load(PROJECT_ID, controller.signal)).rejects.toBeInstanceOf(
      StateLockCancelledError,
    )
  })

  it('recovers a stale lock only after confirming its owner is gone', async () => {
    const directory = await temporaryDirectory()
    const lockPath = join(directory, `${PROJECT_ID}.lock`)
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999_999, createdAtEpochMilliseconds: 0, nonce: 'stale' }),
      'utf8',
    )
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)
    const store = new LocalStateStore(directory, {
      staleLockMilliseconds: 10,
      isProcessAlive: () => false,
    })

    await store.save(stateFixture())

    expect(await store.load(PROJECT_ID)).toEqual(stateFixture())
    expect((await readdir(directory)).some((name) => name.includes('.stale.'))).toBe(false)
  })

  it('does not let a new owner overtake stale-lock recovery', async () => {
    const directory = await temporaryDirectory()
    const recoveryGuardPath = join(directory, `${PROJECT_ID}.lock.recovery`)
    await writeFile(recoveryGuardPath, '', 'utf8')
    const store = new LocalStateStore(directory, {
      lockTimeoutMilliseconds: 15,
      pollIntervalMilliseconds: 2,
    })

    await expect(store.save(stateFixture())).rejects.toBeInstanceOf(StateLockTimeoutError)
    expect(await readdir(directory)).toEqual([`${PROJECT_ID}.lock.recovery`])
  })
})

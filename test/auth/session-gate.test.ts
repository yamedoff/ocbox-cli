import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTH_STATE_LOCK_FILENAME, createSessionGate } from '../../src/auth/session-gate.js'
import { OcboxError } from '../../src/errors/index.js'
import { ExclusiveFileLock } from '../../src/state/exclusive-file-lock.js'
import { deferred } from './doubles.js'

const directories: string[] = []

async function temporaryStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ocbox-session-gate-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

async function holdLock(lockPath: string): Promise<{
  readonly held: Promise<void>
  readonly release: () => void
}> {
  const release = deferred<void>()
  const lock = new ExclusiveFileLock({
    createCancelledError: () => new Error('test-cancelled'),
    createTimeoutError: () => new Error('test-timeout'),
  })
  const held = lock.withLock(lockPath, undefined, () => release.promise)
  await vi.waitFor(() => expect(existsSync(lockPath)).toBe(true))
  return { held, release: () => release.resolve(undefined) }
}

describe('createSessionGate', () => {
  it('retries a briefly contended lock and then runs the action', async () => {
    const stateDirectory = await temporaryStateDirectory()
    const lockPath = join(stateDirectory, AUTH_STATE_LOCK_FILENAME)
    const { held, release } = await holdLock(lockPath)
    const releaseTimer = setTimeout(release, 120)
    try {
      const gate = createSessionGate(stateDirectory, { lockWaitMilliseconds: 50 })

      await expect(gate(async () => 'ran')).resolves.toBe('ran')
    } finally {
      clearTimeout(releaseTimer)
      release()
      await held
    }
  })

  it('fails with a retryable conflict and a next step when the lock stays held', async () => {
    const stateDirectory = await temporaryStateDirectory()
    const lockPath = join(stateDirectory, AUTH_STATE_LOCK_FILENAME)
    const { held, release } = await holdLock(lockPath)
    const releaseTimer = setTimeout(release, 500)
    try {
      const gate = createSessionGate(stateDirectory, { lockWaitMilliseconds: 30 })

      const error: unknown = await gate(async () => 'ran').catch((reason: unknown) => reason)

      expect(error).toBeInstanceOf(OcboxError)
      expect(error).toMatchObject({ code: 'OPERATION_CONFLICT', retryable: true })
      const nextStep = (error as OcboxError).details?.['nextStep']
      expect(typeof nextStep).toBe('string')
      expect(nextStep).toMatch(/rerun|wait/i)
    } finally {
      clearTimeout(releaseTimer)
      release()
      await held
    }
  })

  it('cancels the wait immediately when the signal aborts', async () => {
    const stateDirectory = await temporaryStateDirectory()
    const lockPath = join(stateDirectory, AUTH_STATE_LOCK_FILENAME)
    const { held, release } = await holdLock(lockPath)
    try {
      const gate = createSessionGate(stateDirectory, { lockWaitMilliseconds: 50 })
      const controller = new AbortController()

      const waiting = gate(async () => 'ran', controller.signal)
      controller.abort()

      await expect(waiting).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    } finally {
      release()
      await held
    }
  })
})

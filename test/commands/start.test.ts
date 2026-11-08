import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROJECT_CONFIG } from '../../src/cli/runtime.js'
import Destroy from '../../src/commands/destroy.js'
import Start from '../../src/commands/start.js'
import Status from '../../src/commands/status.js'
import SyncPush from '../../src/commands/sync/push.js'
import type { Session } from '../../src/contracts.js'
import { LifecycleStore, projectIdForPath } from '../../src/lifecycle/index.js'

const originalExitCode = process.exitCode
const originalEnvironment = { ...process.env }
const roots: string[] = []
let root: string
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

function output(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join('')
}

beforeEach(async () => {
  process.exitCode = 0
  root = await mkdtemp(join(tmpdir(), 'ocbox-start-command-'))
  roots.push(root)
  process.env['HOME'] = join(root, 'home')
  process.env['XDG_CONFIG_HOME'] = join(root, 'config')
  process.env['XDG_STATE_HOME'] = join(root, 'state-home')
  process.env['APPDATA'] = join(root, 'appdata')
  process.env['LOCALAPPDATA'] = join(root, 'localappdata')
  process.env['USERPROFILE'] = join(root, 'userprofile')
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
})

afterEach(async () => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  process.exitCode = originalExitCode
  for (const name of Object.keys(process.env)) {
    if (!(name in originalEnvironment)) delete process.env[name]
  }
  Object.assign(process.env, originalEnvironment)
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('start command next step', () => {
  it('points at sync push only until source has been synced to the box', async () => {
    const config = join(root, 'opencloudbox.toml')
    const state = join(root, 'state')
    const local = join(root, 'local')
    await mkdir(local)
    await writeFile(config, DEFAULT_PROJECT_CONFIG)
    const runtime = ['--config', config, '--state-dir', state]

    await Start.run(runtime, { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    expect(output(stdoutSpy)).toMatch(/Next: ocbox sync push\n$/)

    await writeFile(join(local, 'value.txt'), 'content')
    stdoutSpy.mockClear()
    await SyncPush.run([...runtime, '--local-dir', local], { root: process.cwd() })
    expect(process.exitCode ?? 0).toBe(0)

    stdoutSpy.mockClear()
    await Start.run(runtime, { root: process.cwd() })
    expect(process.exitCode ?? 0).toBe(0)
    expect(output(stdoutSpy)).not.toContain('Next: ocbox sync push')
  })
})

describe('destroyed Session selection', () => {
  async function startedProject(): Promise<{
    readonly runtime: string[]
    readonly state: string
    readonly store: LifecycleStore
    readonly sessionId: Session['id']
  }> {
    const config = join(root, 'opencloudbox.toml')
    const state = join(root, 'state')
    await writeFile(config, DEFAULT_PROJECT_CONFIG)
    const runtime = ['--config', config, '--state-dir', state]
    await Start.run(runtime, { root: process.cwd() })
    expect(process.exitCode ?? 0).toBe(0)
    const store = new LifecycleStore(state, projectIdForPath(resolve(process.cwd())))
    const current = await store.load()
    if (current.activeSessionId === null) throw new Error('Expected a selected Session')
    return { runtime, state, store, sessionId: current.activeSessionId }
  }

  it('clears the selection when destroy removes the selected box', async () => {
    const { runtime, store, sessionId } = await startedProject()

    await Destroy.run([...runtime, '--yes'], { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    const state = await store.load()
    expect(state.activeSessionId).toBeNull()
    expect(state.sessions[sessionId]?.state).toBe('destroyed')

    stdoutSpy.mockClear()
    stderrSpy.mockClear()
    await Status.run(runtime, { root: process.cwd() })
    expect(process.exitCode).toBe(1)
    expect(output(stderrSpy)).toContain('No Session is selected')
  })

  it('starts a new box and says so when the selected box is already destroyed', async () => {
    const { runtime, store, sessionId } = await startedProject()
    await Destroy.run([...runtime, '--yes'], { root: process.cwd() })
    expect(process.exitCode ?? 0).toBe(0)
    // Older state can still point at a destroyed Session; start must recover.
    await store.update((current) => ({ ...current, activeSessionId: sessionId }))

    stdoutSpy.mockClear()
    await Start.run(runtime, { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    expect(output(stdoutSpy)).toContain('The selected box was destroyed; started a new one')
    const state = await store.load()
    expect(state.activeSessionId).not.toBe(sessionId)
    const selected =
      state.activeSessionId === null ? undefined : state.sessions[state.activeSessionId]
    expect(selected?.state).toBe('active')
  })
})

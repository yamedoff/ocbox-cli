import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROJECT_CONFIG } from '../../src/cli/runtime.js'
import Start from '../../src/commands/start.js'
import Status from '../../src/commands/status.js'

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
  root = await mkdtemp(join(tmpdir(), 'ocbox-status-command-'))
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

describe('status command project identity', () => {
  it('prints the hosted project ID from opencloudbox.toml, not the internal UUID', async () => {
    const config = join(root, 'opencloudbox.toml')
    const state = join(root, 'state')
    await writeFile(
      config,
      DEFAULT_PROJECT_CONFIG.replace(
        'schemaVersion = 1',
        'schemaVersion = 1\nprojectId = "prj_demo"',
      ),
    )
    const runtime = ['--config', config, '--state-dir', state]

    await Start.run(runtime, { root: process.cwd() })
    expect(process.exitCode ?? 0).toBe(0)

    stdoutSpy.mockClear()
    await Status.run(runtime, { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    expect(output(stdoutSpy)).toContain('project=prj_demo')
    expect(output(stdoutSpy)).not.toMatch(/project=[0-9a-f]{8}-[0-9a-f]{4}-/)
  })
})

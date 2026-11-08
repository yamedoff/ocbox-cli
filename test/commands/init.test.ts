import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Init from '../../src/commands/init.js'

const NOT_LOGGED_IN_MESSAGE =
  'Not logged in. Run `ocbox auth login`, or pass --provider fake to use the local test harness (nothing runs remotely).'
const FAKE_PROVIDER_NOTICE = 'Using the local fake provider; nothing runs remotely.'

const originalExitCode = process.exitCode
const originalEnvironment = { ...process.env }
const roots: string[] = []
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

function output(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join('')
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ocbox-init-command-'))
  roots.push(root)
  // No login metadata or credential can leak in from the developer's home.
  process.env['HOME'] = join(root, 'home')
  process.env['XDG_CONFIG_HOME'] = join(root, 'config')
  process.env['XDG_STATE_HOME'] = join(root, 'state-home')
  process.env['APPDATA'] = join(root, 'appdata')
  process.env['LOCALAPPDATA'] = join(root, 'localappdata')
  process.env['USERPROFILE'] = join(root, 'userprofile')
  return root
}

beforeEach(() => {
  process.exitCode = 0
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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('init command', () => {
  it('fails closed without a login when --provider is omitted', async () => {
    const root = await temporaryRoot()
    const config = join(root, 'opencloudbox.toml')

    await Init.run(['--config', config, '--state-dir', join(root, 'state')], {
      root: process.cwd(),
    })

    expect(process.exitCode).toBe(1)
    expect(output(stderrSpy)).toBe(`${NOT_LOGGED_IN_MESSAGE}\n`)
    await expect(readFile(config, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts an explicit fake provider and prints the notice once', async () => {
    const root = await temporaryRoot()
    const config = join(root, 'opencloudbox.toml')

    await Init.run(['--provider', 'fake', '--config', config, '--state-dir', join(root, 'state')], {
      root: process.cwd(),
    })

    expect(process.exitCode ?? 0).toBe(0)
    expect(output(stdoutSpy)).toBe('Project configuration created\n')
    expect(output(stderrSpy)).toBe(`${FAKE_PROVIDER_NOTICE}\n`)
    expect(await readFile(config, 'utf8')).toContain('name = "fake"')
  })
})

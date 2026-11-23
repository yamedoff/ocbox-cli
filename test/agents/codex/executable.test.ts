import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CODEX_VERSION_ARGUMENTS,
  CODEX_VERSION_TIMEOUT_MILLISECONDS,
  type CodexExecOptions,
  type CodexExecResult,
  defaultCodexVersionExecutor,
  readInstalledCodexVersion,
  resolveCodexExecutable,
} from '../../../src/agents/codex/executable.js'

type RunCall = readonly [string, readonly string[], number]

function captureRun(result: CodexExecResult = { stdout: '', stderr: '' }): {
  readonly calls: RunCall[]
  readonly run: (
    executable: string,
    args: readonly string[],
    timeout: number,
  ) => Promise<CodexExecResult>
} {
  const calls: RunCall[] = []
  return {
    calls,
    run: async (executable, args, timeout) => {
      calls.push([executable, args, timeout])
      return result
    },
  }
}

describe('resolveCodexExecutable', () => {
  it('resolves a POSIX executable using the executable bit', async () => {
    const checked: string[] = []
    const resolved = await resolveCodexExecutable({
      platform: 'linux',
      environment: { PATH: '/usr/local/bin:/usr/bin' },
      isExecutableFile: async (candidate, platform) => {
        checked.push(candidate)
        expect(platform).toBe('linux')
        return candidate === '/usr/bin/codex'
      },
    })
    expect(resolved).toBe('/usr/bin/codex')
    expect(checked).toEqual(['/usr/local/bin/codex', '/usr/bin/codex'])
  })

  it('resolves a Windows npm .cmd shim through PATHEXT', async () => {
    // Windows is case-insensitive: PATHEXT is uppercase while the npm shim on
    // disk is `codex.cmd`, so the lookup must not depend on exact casing.
    const existing = new Set(['c:\\users\\ada\\appdata\\roaming\\npm\\codex.cmd'])
    const resolved = await resolveCodexExecutable({
      platform: 'win32',
      environment: {
        PATH: 'C:\\nodejs;C:\\Users\\ada\\AppData\\Roaming\\npm',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      },
      isExecutableFile: async (candidate, platform) => {
        expect(platform).toBe('win32')
        return existing.has(candidate.toLowerCase())
      },
    })
    expect(resolved?.toLowerCase()).toBe('c:\\users\\ada\\appdata\\roaming\\npm\\codex.cmd')
  })

  it('honours PATHEXT order and finds a .bat shim', async () => {
    const bat = await resolveCodexExecutable({
      platform: 'win32',
      environment: { PATH: 'C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      isExecutableFile: async (candidate) => candidate.toLowerCase() === 'c:\\tools\\codex.bat',
    })
    expect(bat?.toLowerCase()).toBe('c:\\tools\\codex.bat')

    const exeWins = await resolveCodexExecutable({
      platform: 'win32',
      environment: { PATH: 'C:\\tools', PATHEXT: '.EXE;.CMD' },
      isExecutableFile: async (candidate) =>
        candidate.toLowerCase() === 'c:\\tools\\codex.exe' ||
        candidate.toLowerCase() === 'c:\\tools\\codex.cmd',
    })
    expect(exeWins?.toLowerCase()).toBe('c:\\tools\\codex.exe')
  })

  it('falls back to the documented default PATHEXT when the environment omits it', async () => {
    const resolved = await resolveCodexExecutable({
      platform: 'win32',
      environment: { PATH: 'C:\\tools' },
      isExecutableFile: async (candidate) => candidate.toLowerCase() === 'c:\\tools\\codex.cmd',
    })
    expect(resolved?.toLowerCase()).toBe('c:\\tools\\codex.cmd')
  })

  it('returns null when PATH is empty or no candidate is executable', async () => {
    expect(
      await resolveCodexExecutable({
        platform: 'linux',
        environment: {},
        isExecutableFile: async () => true,
      }),
    ).toBeNull()
    expect(
      await resolveCodexExecutable({
        platform: 'linux',
        environment: { PATH: '/usr/bin' },
        isExecutableFile: async () => false,
      }),
    ).toBeNull()
  })
})

describe('readInstalledCodexVersion', () => {
  it('executes the resolved binary with the fixed --version argv and no shell', async () => {
    const seen: Array<{
      readonly executable: string
      readonly args: readonly string[]
      readonly options: CodexExecOptions
    }> = []
    const result = await readInstalledCodexVersion({
      platform: 'linux',
      environment: { PATH: '/usr/local/bin' },
      isExecutableFile: async (candidate) => candidate === '/usr/local/bin/codex',
      execFile: async (executable, args, options) => {
        seen.push({ executable, args, options })
        return { stdout: 'codex-cli 0.153.4 (abc123)\n', stderr: '' }
      },
    })
    expect(result).toBe('codex-cli 0.153.4 (abc123)')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.executable).toBe('/usr/local/bin/codex')
    expect(seen[0]?.args).toEqual([...CODEX_VERSION_ARGUMENTS])
    expect(seen[0]?.options.timeoutMilliseconds).toBe(CODEX_VERSION_TIMEOUT_MILLISECONDS)
    expect(Object.keys(seen[0]?.options ?? {})).toEqual(['timeoutMilliseconds'])
  })

  it('uses a pre-resolved executable without scanning PATH again', async () => {
    const seen: string[] = []
    const result = await readInstalledCodexVersion({
      platform: 'win32',
      environment: { PATH: 'C:\\nope' },
      executable: 'C:\\tools\\codex.cmd',
      isExecutableFile: async () => {
        throw new Error('must not scan PATH when an executable is supplied')
      },
      execFile: async (executable) => {
        seen.push(executable)
        return { stdout: 'codex-cli 0.153.4', stderr: '' }
      },
    })
    expect(result).toBe('codex-cli 0.153.4')
    expect(seen).toEqual(['C:\\tools\\codex.cmd'])
  })

  it('returns an empty string without executing anything when no binary resolves', async () => {
    let executed = false
    const result = await readInstalledCodexVersion({
      platform: 'linux',
      environment: { PATH: '/usr/bin' },
      isExecutableFile: async () => false,
      execFile: async () => {
        executed = true
        return { stdout: '', stderr: '' }
      },
    })
    expect(result).toBe('')
    expect(executed).toBe(false)
  })

  it('returns an empty string when the executor fails', async () => {
    const result = await readInstalledCodexVersion({
      platform: 'linux',
      environment: { PATH: '/usr/bin' },
      isExecutableFile: async () => true,
      execFile: async () => {
        throw new Error('spawn failed')
      },
    })
    expect(result).toBe('')
  })

  it.skipIf(process.platform === 'win32')(
    'resolves and launches a real POSIX executable on PATH',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocbox-codex-exec-'))
      try {
        const script = join(root, 'codex')
        await writeFile(script, '#!/bin/sh\necho "codex-cli 0.153.4"\n', 'utf8')
        await chmod(script, 0o755)
        const result = await readInstalledCodexVersion({
          platform: 'linux',
          environment: { PATH: root },
        })
        expect(result).toBe('codex-cli 0.153.4')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})

describe('defaultCodexVersionExecutor', () => {
  it('launches a native executable directly without a shell', async () => {
    const { calls, run } = captureRun({ stdout: 'ok', stderr: '' })
    const executor = defaultCodexVersionExecutor('linux', run)
    await executor('/usr/local/bin/codex', [...CODEX_VERSION_ARGUMENTS], {
      timeoutMilliseconds: 15_000,
    })
    expect(calls).toEqual([['/usr/local/bin/codex', ['--version'], 15_000]])
  })

  it('launches a Windows .cmd shim through cmd.exe with a quoted path', async () => {
    const { calls, run } = captureRun({ stdout: 'ok', stderr: '' })
    const executor = defaultCodexVersionExecutor('win32', run)
    await executor('C:\\Users\\ada\\AppData\\Roaming\\npm\\codex.cmd', ['--version'], {
      timeoutMilliseconds: 15_000,
    })
    expect(calls).toHaveLength(1)
    const [executable, args, timeout] = calls[0] ?? ['', [], 0]
    expect(executable).toBe('cmd.exe')
    expect(args).toEqual([
      '/d',
      '/s',
      '/c',
      '"C:\\Users\\ada\\AppData\\Roaming\\npm\\codex.cmd" --version',
    ])
    expect(timeout).toBe(15_000)
  })

  it('runs a .bat shim through cmd.exe but a .exe directly', async () => {
    const bat = captureRun()
    await defaultCodexVersionExecutor('win32', bat.run)('C:\\tools\\codex.bat', ['--version'], {
      timeoutMilliseconds: 1_000,
    })
    expect(bat.calls[0]?.[0]).toBe('cmd.exe')

    const exe = captureRun()
    await defaultCodexVersionExecutor('win32', exe.run)(
      'C:\\Program Files\\Codex\\codex.exe',
      ['--version'],
      { timeoutMilliseconds: 1_000 },
    )
    expect(exe.calls[0]?.[0]).toBe('C:\\Program Files\\Codex\\codex.exe')
  })

  it('refuses a shim path containing shell metacharacters', async () => {
    const { run } = captureRun()
    const executor = defaultCodexVersionExecutor('win32', run)
    await expect(
      executor('C:\\tools\\codex&echo.cmd', ['--version'], { timeoutMilliseconds: 15_000 }),
    ).rejects.toThrow(/shell metacharacters/)
    await expect(
      executor('C:\\tools\\codex|calc.cmd', ['--version'], { timeoutMilliseconds: 15_000 }),
    ).rejects.toThrow(/shell metacharacters/)
  })

  it('refuses an argument that is unsafe for a Windows shim command', async () => {
    const { run } = captureRun()
    const executor = defaultCodexVersionExecutor('win32', run)
    await expect(
      executor('C:\\tools\\codex.cmd', ['--version & echo pwned'], {
        timeoutMilliseconds: 15_000,
      }),
    ).rejects.toThrow(/unsafe argument/)
  })
})

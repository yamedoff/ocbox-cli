import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_VERSION_ARGUMENTS,
  CLAUDE_VERSION_TIMEOUT_MILLISECONDS,
  type ClaudeExecOptions,
  type ClaudeExecResult,
  defaultClaudeVersionExecutor,
  readInstalledClaudeVersion,
  resolveClaudeExecutable,
} from '../../../src/agents/claude-code/claude-executable.js'

type RunCall = readonly [string, readonly string[], number]

function captureRun(result: ClaudeExecResult = { stdout: '', stderr: '' }): {
  readonly calls: RunCall[]
  readonly run: (
    executable: string,
    args: readonly string[],
    timeout: number,
  ) => Promise<ClaudeExecResult>
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

describe('resolveClaudeExecutable', () => {
  it('resolves a POSIX executable using the executable bit', async () => {
    const checked: string[] = []
    const resolved = await resolveClaudeExecutable({
      platform: 'linux',
      environment: { PATH: '/usr/local/bin:/usr/bin' },
      isExecutableFile: async (candidate, platform) => {
        checked.push(candidate)
        expect(platform).toBe('linux')
        return candidate === '/usr/bin/claude'
      },
    })
    expect(resolved).toBe('/usr/bin/claude')
    expect(checked).toEqual(['/usr/local/bin/claude', '/usr/bin/claude'])
  })

  it('resolves a Windows npm .cmd shim through PATHEXT', async () => {
    // Windows is case-insensitive: PATHEXT is uppercase while the npm shim on
    // disk is `claude.cmd`, so the lookup must not depend on exact casing.
    const existing = new Set(['c:\\users\\ada\\appdata\\roaming\\npm\\claude.cmd'])
    const resolved = await resolveClaudeExecutable({
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
    expect(resolved?.toLowerCase()).toBe('c:\\users\\ada\\appdata\\roaming\\npm\\claude.cmd')
  })

  it('honours PATHEXT order and finds a .bat shim', async () => {
    const existing = new Set(['c:\\tools\\claude.bat'])
    const resolved = await resolveClaudeExecutable({
      platform: 'win32',
      environment: { PATH: 'C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      isExecutableFile: async (candidate) => existing.has(candidate.toLowerCase()),
    })
    expect(resolved?.toLowerCase()).toBe('c:\\tools\\claude.bat')

    const exeWins = await resolveClaudeExecutable({
      platform: 'win32',
      environment: { PATH: 'C:\\tools', PATHEXT: '.EXE;.CMD' },
      isExecutableFile: async (candidate) =>
        candidate.toLowerCase() === 'c:\\tools\\claude.exe' ||
        candidate.toLowerCase() === 'c:\\tools\\claude.cmd',
    })
    expect(exeWins?.toLowerCase()).toBe('c:\\tools\\claude.exe')
  })

  it('falls back to the documented default PATHEXT when the environment omits it', async () => {
    const resolved = await resolveClaudeExecutable({
      platform: 'win32',
      environment: { PATH: 'C:\\tools' },
      isExecutableFile: async (candidate) => candidate.toLowerCase() === 'c:\\tools\\claude.cmd',
    })
    expect(resolved?.toLowerCase()).toBe('c:\\tools\\claude.cmd')
  })

  it('returns null when PATH is empty or no candidate is executable', async () => {
    expect(
      await resolveClaudeExecutable({
        platform: 'linux',
        environment: {},
        isExecutableFile: async () => true,
      }),
    ).toBeNull()
    expect(
      await resolveClaudeExecutable({
        platform: 'linux',
        environment: { PATH: '/usr/bin' },
        isExecutableFile: async () => false,
      }),
    ).toBeNull()
  })
})

describe('readInstalledClaudeVersion', () => {
  it('executes the resolved binary with the fixed --version argv and no shell', async () => {
    const seen: Array<{
      readonly executable: string
      readonly args: readonly string[]
      readonly options: ClaudeExecOptions
    }> = []
    const result = await readInstalledClaudeVersion({
      platform: 'linux',
      environment: { PATH: '/usr/local/bin' },
      isExecutableFile: async (candidate) => candidate === '/usr/local/bin/claude',
      execFile: async (executable, args, options) => {
        seen.push({ executable, args, options })
        return { stdout: '2.0.51 (Claude Code)\n', stderr: '' }
      },
    })
    expect(result).toBe('2.0.51 (Claude Code)')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.executable).toBe('/usr/local/bin/claude')
    expect(seen[0]?.args).toEqual([...CLAUDE_VERSION_ARGUMENTS])
    expect(seen[0]?.options.timeoutMilliseconds).toBe(CLAUDE_VERSION_TIMEOUT_MILLISECONDS)
    expect(Object.keys(seen[0]?.options ?? {})).toEqual(['timeoutMilliseconds'])
  })

  it('returns an empty string without executing anything when no binary resolves', async () => {
    let executed = false
    const result = await readInstalledClaudeVersion({
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
    const result = await readInstalledClaudeVersion({
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
      const root = await mkdtemp(join(tmpdir(), 'ocbox-claude-exec-'))
      try {
        const script = join(root, 'claude')
        await writeFile(script, '#!/bin/sh\necho "2.0.51 (Claude Code)"\n', 'utf8')
        await chmod(script, 0o755)
        const result = await readInstalledClaudeVersion({
          platform: 'linux',
          environment: { PATH: root },
        })
        expect(result).toBe('2.0.51 (Claude Code)')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})

describe('defaultClaudeVersionExecutor', () => {
  it('launches a native executable directly without a shell', async () => {
    const { calls, run } = captureRun({ stdout: 'ok', stderr: '' })
    const executor = defaultClaudeVersionExecutor('linux', run)
    await executor('/usr/local/bin/claude', [...CLAUDE_VERSION_ARGUMENTS], {
      timeoutMilliseconds: 15_000,
    })
    expect(calls).toEqual([['/usr/local/bin/claude', ['--version'], 15_000]])
  })

  it('launches a Windows .cmd shim through cmd.exe with a quoted path', async () => {
    const { calls, run } = captureRun({ stdout: 'ok', stderr: '' })
    const executor = defaultClaudeVersionExecutor('win32', run)
    await executor('C:\\Users\\ada\\AppData\\Roaming\\npm\\claude.cmd', ['--version'], {
      timeoutMilliseconds: 15_000,
    })
    expect(calls).toHaveLength(1)
    const [executable, args, timeout] = calls[0] ?? ['', [], 0]
    expect(executable).toBe('cmd.exe')
    expect(args).toEqual([
      '/d',
      '/s',
      '/c',
      '"C:\\Users\\ada\\AppData\\Roaming\\npm\\claude.cmd" --version',
    ])
    expect(timeout).toBe(15_000)
  })

  it('runs a Windows .exe directly instead of through cmd.exe', async () => {
    const { calls, run } = captureRun()
    const executor = defaultClaudeVersionExecutor('win32', run)
    await executor('C:\\Program Files\\Claude\\claude.exe', ['--version'], {
      timeoutMilliseconds: 15_000,
    })
    expect(calls[0]?.[0]).toBe('C:\\Program Files\\Claude\\claude.exe')
  })

  it('refuses a shim path containing shell metacharacters', async () => {
    const { run } = captureRun()
    const executor = defaultClaudeVersionExecutor('win32', run)
    await expect(
      executor('C:\\tools\\claude&echo.cmd', ['--version'], { timeoutMilliseconds: 15_000 }),
    ).rejects.toThrow(/shell metacharacters/)
  })

  it('refuses an argument that is unsafe for a Windows shim command', async () => {
    const { run } = captureRun()
    const executor = defaultClaudeVersionExecutor('win32', run)
    await expect(
      executor('C:\\tools\\claude.cmd', ['--version & echo pwned'], {
        timeoutMilliseconds: 15_000,
      }),
    ).rejects.toThrow(/unsafe argument/)
  })
})

describe('centralized version discovery wiring', () => {
  it('makes setup, doctor, and remove delegate to one helper', async () => {
    for (const command of ['setup', 'doctor', 'remove']) {
      const source = await readFile(
        new URL(`../../../src/commands/agent/${command}.ts`, import.meta.url),
        'utf8',
      )
      expect(source).toContain('readInstalledClaudeVersion')
      expect(source).not.toContain("'node:child_process'")
      expect(source).not.toContain('function readInstalledVersion')
    }
  })
})

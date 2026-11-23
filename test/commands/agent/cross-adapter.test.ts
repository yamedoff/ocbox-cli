import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flagProvidedChecker,
  irrelevantFlagWarnings,
} from '../../../src/commands/agent/adapter-flags.js'
import AgentDoctor from '../../../src/commands/agent/doctor.js'
import AgentHook from '../../../src/commands/agent/hook.js'
import AgentTopic from '../../../src/commands/agent/index.js'
import AgentRemove from '../../../src/commands/agent/remove.js'
import AgentSetup from '../../../src/commands/agent/setup.js'
import { ADAPTER_ID as CodexAdapterId } from '../../../src/agents/codex/hook-helper.js'
import * as agents from '../../../src/agents/index.js'

const codexMocks = vi.hoisted(() => ({
  readInstalledCodexVersion: vi.fn(async () => 'codex-cli 0.153.4 (abc123)'),
  resolveCodexExecutable: vi.fn(async () => 'codex'),
  resolveSessionSelection: vi.fn(async () => ({ sessionId: 'sess-test-1', recorded: true })),
}))

vi.mock('../../../src/agents/codex/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/agents/codex/index.js')>()
  return {
    ...actual,
    readInstalledCodexVersion: codexMocks.readInstalledCodexVersion,
    resolveCodexExecutable: codexMocks.resolveCodexExecutable,
    resolveSessionSelection: codexMocks.resolveSessionSelection,
  }
})

const temps: string[] = []
const originalExitCode = process.exitCode
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  process.exitCode = undefined
})

afterEach(async () => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  await Promise.all(temps.splice(0).map((root) => rm(root, { force: true, recursive: true })))
  process.exitCode = originalExitCode
  codexMocks.resolveSessionSelection.mockReset()
  codexMocks.resolveSessionSelection.mockResolvedValue({ sessionId: 'sess-test-1', recorded: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ocbox-agent-xadapter-'))
  temps.push(root)
  return root
}

function stdoutText(): string {
  return stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('')
}

function stderrText(): string {
  return stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('')
}

describe('adapter-irrelevant flag warnings', () => {
  it('names codex-only flags for claude-code setup', () => {
    const warnings = irrelevantFlagWarnings('claude-code', 'setup', (flag) => flag === 'yes')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('--yes is a codex-only flag and is ignored for claude-code')
  })

  it('names claude-code-only flags for codex setup', () => {
    const warnings = irrelevantFlagWarnings('codex', 'setup', (flag) => flag === 'claude-version')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(
      '--claude-version is a claude-code-only flag and is ignored for codex',
    )
  })

  it('covers doctor and remove in both directions', () => {
    expect(irrelevantFlagWarnings('codex', 'doctor', (flag) => flag === 'scope')).toHaveLength(1)
    expect(
      irrelevantFlagWarnings('claude-code', 'doctor', (flag) => flag === 'codex-home'),
    ).toHaveLength(1)
    expect(irrelevantFlagWarnings('claude-code', 'remove', (flag) => flag === 'yes')).toHaveLength(
      1,
    )
    expect(irrelevantFlagWarnings('codex', 'remove', () => false)).toHaveLength(0)
  })

  it('has no irrelevant flags for the shared hook surface', () => {
    expect(irrelevantFlagWarnings('codex', 'hook', () => true)).toHaveLength(0)
    expect(irrelevantFlagWarnings('claude-code', 'hook', () => true)).toHaveLength(0)
  })

  it('attributes only explicitly provided flags', () => {
    const checker = flagProvidedChecker(
      { scope: 'project', layer: 'user', yes: true, session: undefined },
      { flags: { scope: { setFromDefault: true }, layer: {} } },
    )
    expect(checker('scope')).toBe(false)
    expect(checker('layer')).toBe(true)
    expect(checker('yes')).toBe(true)
    expect(checker('session')).toBe(false)
    expect(checker('missing')).toBe(false)
  })
})

describe('agent topic dispatch', () => {
  it('lists both adapters and the plan/apply contract', async () => {
    // oclif topic output goes through `console.log`; capture it by direct
    // assignment (`vi.spyOn` does not observe that path under vitest).
    const logged: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => {
      logged.push(args.map((arg) => String(arg)).join(' '))
    }
    try {
      await AgentTopic.run([], { root: process.cwd() })
    } finally {
      console.log = originalLog
    }
    const output = `${stdoutText()}\n${logged.join('\n')}`
    expect(output).toContain('codex')
    expect(output).toContain('claude-code')
    expect(output).toContain('--yes')
  })

  it('rejects an unknown adapter for setup, doctor, and remove', async () => {
    await expect(AgentSetup.run(['bogus'], { root: process.cwd() })).rejects.toThrow(
      /unknown adapter "bogus"/,
    )
    await expect(AgentDoctor.run(['bogus'], { root: process.cwd() })).rejects.toThrow(
      /unknown adapter "bogus"/,
    )
    await expect(AgentRemove.run(['bogus'], { root: process.cwd() })).rejects.toThrow(
      /unknown adapter "bogus"/,
    )
  })

  it('fails the hook closed with exit 2 for an unknown adapter', async () => {
    await AgentHook.run(['bogus'], { root: process.cwd() })
    expect(process.exitCode).toBe(2)
    expect(stderrText()).toContain('unknown adapter "bogus"')
  })
})

describe('codex setup plan-mode blockers', () => {
  it('exits nonzero while keeping the machine-readable plan on stdout', async () => {
    codexMocks.resolveSessionSelection.mockResolvedValue({
      sessionId: 'sess-missing',
      recorded: false,
    })
    const root = await tempRoot()
    await AgentSetup.run(
      [
        'codex',
        '--json',
        '--codex-home',
        join(root, 'codex-home'),
        '--state-dir',
        join(root, 'state'),
      ],
      { root: process.cwd() },
    )
    expect(process.exitCode).toBe(2)
    expect(stdoutText()).toContain('"ok": false')
    expect(stdoutText()).toContain('not recorded')
  })

  it('warns for claude-code-only flags and stays silent for defaulted scope', async () => {
    const root = await tempRoot()
    await AgentSetup.run(
      [
        'codex',
        '--claude-version',
        '9.9.9',
        '--codex-home',
        join(root, 'codex-home'),
        '--state-dir',
        join(root, 'state'),
      ],
      { root: process.cwd() },
    )
    expect(process.exitCode ?? 0).toBe(0)
    expect(stdoutText()).toContain(
      '--claude-version is a claude-code-only flag and is ignored for codex',
    )
    expect(stdoutText()).not.toContain('--scope is a claude-code-only flag')
  })
})

describe('claude-code irrelevant flags stay off stdout', () => {
  it('warns on stderr for a codex-only flag without touching the JSON channel', async () => {
    const root = await tempRoot()
    await AgentSetup.run(
      [
        'claude-code',
        '--yes',
        '--json',
        '--project-dir',
        join(root, 'repo'),
        '--state-dir',
        join(root, 'state'),
      ],
      { root: process.cwd() },
    )
    expect(stderrText()).toContain('--yes is a codex-only flag and is ignored for claude-code')
    expect(stdoutText()).not.toContain('codex-only flag')
  })
})

describe('top-level agent exports stay unambiguous', () => {
  it('resolves the shared names to codex while claude-code stays namespaced', () => {
    expect(CodexAdapterId).toBe('codex')
    expect(agents.ADAPTER_ID).toBe('codex')
    expect(agents.claudeCode.ADAPTER_ID).toBe('claude-code')
    expect(agents.codexAdapter.ADAPTER_ID).toBe('codex')
    expect(agents.claudeCode.ADAPTER_ID).not.toBe(agents.ADAPTER_ID)
  })
})

describe('codex adapter docs examples', () => {
  const docPath = new URL('../../../docs/codex-adapter.md', import.meta.url)
  const doc = readFileSync(docPath, 'utf8')

  it('documents every required behavior surface', () => {
    for (const topic of [
      'ocbox agent setup codex',
      'ocbox agent remove codex',
      'ocbox agent hook codex',
      'manifest',
      'exits `2`',
      'CODEX_HOME',
      'byte-splicing',
    ]) {
      expect(doc).toContain(topic)
    }
  })

  it('keeps the documented flags on the real commands', () => {
    const setupFlags = Object.keys(AgentSetup.flags ?? {})
    for (const flag of [
      'layer',
      'session',
      'codex-home',
      'project-dir',
      'allow-unverified-schema',
      'yes',
      'ocbox-bin',
    ]) {
      expect(setupFlags).toContain(flag)
    }
    const removeFlags = Object.keys(AgentRemove.flags ?? {})
    for (const flag of ['layer', 'codex-home', 'project-dir', 'yes']) {
      expect(removeFlags).toContain(flag)
    }
  })
})

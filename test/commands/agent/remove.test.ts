import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentRemove from '../../../src/commands/agent/remove.js'
import AgentSetup from '../../../src/commands/agent/setup.js'

const mocks = vi.hoisted(() => ({
  runCodexVersion: vi.fn(async () => 'codex-cli 0.153.4 (abc123)'),
  detectCodexExecutable: vi.fn(() => 'codex'),
  resolveSessionSelection: vi.fn(async () => ({ sessionId: 'sess-test-1', recorded: true })),
}))

vi.mock('../../../src/agents/codex/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/agents/codex/index.js')>()
  return {
    ...actual,
    runCodexVersion: mocks.runCodexVersion,
    detectCodexExecutable: mocks.detectCodexExecutable,
    resolveSessionSelection: mocks.resolveSessionSelection,
  }
})

function canCreateDirectoryLink(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'ocbox-agent-remove-linkprobe-'))
  try {
    mkdirSync(join(root, 'target'))
    symlinkSync(join(root, 'target'), join(root, 'link'), 'junction')
    return true
  } catch {
    return false
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const CAN_DIRECTORY_LINK = canCreateDirectoryLink()
const temps: string[] = []
const originalExitCode = process.exitCode
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
})

afterEach(async () => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  await Promise.all(temps.splice(0).map((root) => rm(root, { force: true, recursive: true })))
  process.exitCode = originalExitCode
  mocks.resolveSessionSelection.mockReset()
  mocks.resolveSessionSelection.mockResolvedValue({ sessionId: 'sess-test-1', recorded: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ocbox-agent-remove-'))
  temps.push(root)
  return root
}

async function trustProject(codexHome: string, projectDir: string): Promise<void> {
  await mkdir(codexHome, { recursive: true })
  await writeFile(
    join(codexHome, 'config.toml'),
    `[projects.'${projectDir}']\ntrust_level = "trusted"\n`,
  )
}

function codexArgs(projectDir: string, codexHome: string, stateDir: string): string[] {
  return [
    'codex',
    '--layer',
    'project',
    '--yes',
    '--json',
    '--project-dir',
    projectDir,
    '--codex-home',
    codexHome,
    '--state-dir',
    stateDir,
  ]
}

describe('agent remove codex command path boundary', () => {
  it.skipIf(!CAN_DIRECTORY_LINK)(
    'refuses to remove through a .codex directory link escaping the project',
    async () => {
      const root = await tempRoot()
      const projectDir = join(root, 'repo')
      const codexHome = join(root, 'codex-home')
      const stateDir = join(root, 'state')
      const outside = join(root, 'outside')
      await mkdir(projectDir, { recursive: true })
      await trustProject(codexHome, projectDir)

      await AgentSetup.run(codexArgs(projectDir, codexHome, stateDir), { root: process.cwd() })
      expect(process.exitCode ?? 0).toBe(0)

      const hooksBefore = await readFile(join(projectDir, '.codex', 'hooks.json'), 'utf8')
      await rename(join(projectDir, '.codex'), outside)
      await symlink(outside, join(projectDir, '.codex'), 'junction')
      process.exitCode = originalExitCode

      await AgentRemove.run(codexArgs(projectDir, codexHome, stateDir), { root: process.cwd() })

      expect(process.exitCode).toBe(1)
      expect(await readFile(join(outside, 'hooks.json'), 'utf8')).toBe(hooksBefore)
      const entries = await readdir(outside)
      expect(entries.some((entry) => entry.includes('ocbox-backup'))).toBe(false)
      expect(stderrSpy).toHaveBeenCalled()
    },
  )
})

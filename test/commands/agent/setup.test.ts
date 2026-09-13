import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const temps: string[] = []
const originalExitCode = process.exitCode
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ocbox-agent-setup-'))
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

function projectSetupArgs(projectDir: string, codexHome: string, stateDir: string): string[] {
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

afterEach(async () => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  await Promise.all(temps.splice(0).map((root) => rm(root, { force: true, recursive: true })))
  process.exitCode = originalExitCode
  mocks.resolveSessionSelection.mockReset()
  mocks.resolveSessionSelection.mockResolvedValue({ sessionId: 'sess-test-1', recorded: true })
})

describe('agent setup codex command', () => {
  it('applies the project layer inside the project root', async () => {
    const root = await tempRoot()
    const projectDir = join(root, 'repo')
    const codexHome = join(root, 'codex-home')
    const stateDir = join(root, 'state')
    await mkdir(projectDir, { recursive: true })
    await trustProject(codexHome, projectDir)

    await AgentSetup.run(projectSetupArgs(projectDir, codexHome, stateDir), { root: process.cwd() })

    expect(process.exitCode ?? 0).toBe(0)
    const hooks = JSON.parse(await readFile(join(projectDir, '.codex', 'hooks.json'), 'utf8'))
    expect(JSON.stringify(hooks)).toContain('sess-test-1')
    const manifest = JSON.parse(
      await readFile(join(stateDir, 'agents', 'codex', 'project', 'manifest.json'), 'utf8'),
    )
    expect(manifest.layer).toBe('project')
    expect(manifest.fragments).toHaveLength(1)
    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toContain('trust_level')
  })

  it('refuses an explicit unrecorded Session before writing', async () => {
    mocks.resolveSessionSelection.mockResolvedValue({ sessionId: 'sess-missing', recorded: false })
    const root = await tempRoot()
    const projectDir = join(root, 'repo')
    const codexHome = join(root, 'codex-home')
    const stateDir = join(root, 'state')
    await mkdir(projectDir, { recursive: true })
    await trustProject(codexHome, projectDir)

    await AgentSetup.run(projectSetupArgs(projectDir, codexHome, stateDir), { root: process.cwd() })

    expect(process.exitCode).toBe(1)
    await expect(readFile(join(projectDir, '.codex', 'hooks.json'), 'utf8')).rejects.toThrow()
  })
})

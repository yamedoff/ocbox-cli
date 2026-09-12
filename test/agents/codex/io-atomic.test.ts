import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  backupFileTo,
  backupTimestamp,
  writeFileAtomic,
} from '../../../src/agents/codex/atomic-write.js'
import {
  CodexManifestSchema,
  manifestBackupDirectory,
  manifestFile,
} from '../../../src/agents/codex/manifest.js'
import { detectCodexExecutable, projectTrustLevel } from '../../../src/agents/codex/io.js'
import { parseCodexToml } from '../../../src/agents/codex/toml-merge.js'

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ocbox-codex-'))
}

describe('codex atomic writes and backups', () => {
  it('writes atomically with a timestamped backup', async () => {
    const directory = await temporaryDirectory()
    try {
      const target = join(directory, 'config.toml')
      await writeFileAtomic(target, 'model = "a"\n')
      const backup = await backupFileTo(target, join(directory, 'backups'), backupTimestamp())
      expect(backup).toMatch(/config\.toml\.\d+T\d+-?\d*Z?\.bak/)
      await writeFileAtomic(target, 'model = "b"\n')
      expect(await readFile(target, 'utf8')).toBe('model = "b"\n')
      expect(await readFile(backup ?? '', 'utf8')).toBe('model = "a"\n')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns null when backing up a missing file', async () => {
    const directory = await temporaryDirectory()
    try {
      expect(
        await backupFileTo(join(directory, 'missing.toml'), join(directory, 'b'), 'ts'),
      ).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('validates the owned-fragment manifest in the state directory', () => {
    const state = '/tmp/ocbox-state'
    expect(manifestFile(state)).toBe('/tmp/ocbox-state/agents/codex/manifest.json')
    expect(manifestBackupDirectory(state)).toBe('/tmp/ocbox-state/agents/codex/backups')
    const manifest = {
      schemaVersion: 1,
      adapter: 'codex',
      adapterVersion: 'ocbox-codex-adapter-v1',
      codexVersion: '0.153.4',
      layer: 'user',
      codexHome: '/home/ada/.codex',
      projectDirectory: null,
      configFile: '/home/ada/.codex/config.toml',
      hooksFile: '/home/ada/.codex/hooks.json',
      hookRepresentation: 'hooks-json',
      sessionId: 'sess-1',
      ownedTomlText: 'a',
      ownedHooksText: 'b',
      backupConfigPath: null,
      backupHooksPath: null,
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
    }
    expect(CodexManifestSchema.parse(manifest).sessionId).toBe('sess-1')
  })
})

describe('codex executable detection', () => {
  it('returns null for empty search paths', () => {
    expect(detectCodexExecutable('')).toBeNull()
    expect(detectCodexExecutable('/nope:/also-nope')).toBeNull()
  })

  it('finds codex.exe in a synthetic search path', async () => {
    const directory = await temporaryDirectory()
    try {
      const win = join(directory, 'bin')
      await rm(win, { recursive: true, force: true })
      const { mkdir, writeFile } = await import('node:fs/promises')
      await mkdir(win, { recursive: true })
      await writeFile(join(win, 'codex.exe'), 'binary', 'utf8')
      expect(detectCodexExecutable(`${win};C:\\nope`)).toBe(`${win}/codex.exe`)
      expect(detectCodexExecutable('/nope:/also-nope')).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('codex project trust lookup', () => {
  it('reads trust levels without auto-trusting unknown repositories', () => {
    const toml = '[projects."/srv/repo"]\ntrust_level = "trusted"\n'
    expect(projectTrustLevel(toml, ['/srv/repo'], parseCodexToml)).toBe('trusted')
    expect(projectTrustLevel(toml, ['/srv/other'], parseCodexToml)).toBeNull()
    expect(projectTrustLevel(null, ['/srv/repo'], parseCodexToml)).toBeNull()
    expect(projectTrustLevel('model = [oops', ['/srv/repo'], parseCodexToml)).toBeNull()
  })
})

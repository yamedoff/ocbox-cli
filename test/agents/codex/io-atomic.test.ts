import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeCodexFileSystem } from '../../../src/agents/codex/fs.js'
import {
  CodexManifestSchema,
  manifestBackupDirectory,
  manifestFile,
  manifestPathForLayer,
} from '../../../src/agents/codex/manifest.js'
import { projectTrustLevel } from '../../../src/agents/codex/io.js'
import { parseCodexToml } from '../../../src/agents/codex/codec.js'
import { determineProjectTrust, normalizeProjectKey } from '../../../src/agents/codex/trust.js'

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ocbox-codex-'))
}

describe('codex atomic writes and backups', () => {
  it('writes atomically with a timestamped sibling backup', async () => {
    const directory = await temporaryDirectory()
    try {
      const target = join(directory, 'hooks.json')
      await nodeCodexFileSystem.writeFileAtomic(target, '{"hooks":{}}\n')
      const backup = `${target}.2026-09-12T00-00-00-000Z.ocbox-backup`
      await nodeCodexFileSystem.writeFileAtomic(backup, '{"hooks":{}}\n')
      await nodeCodexFileSystem.writeFileAtomic(target, '{"hooks":{"Stop":[]}}\n')
      expect(await readFile(target, 'utf8')).toBe('{"hooks":{"Stop":[]}}\n')
      expect(await readFile(backup, 'utf8')).toBe('{"hooks":{}}\n')
      await nodeCodexFileSystem.deleteFile(target)
      await expect(readFile(target, 'utf8')).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reads a missing file as null instead of throwing', async () => {
    const directory = await temporaryDirectory()
    try {
      expect(await nodeCodexFileSystem.readFile(join(directory, 'missing.toml'))).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('validates the per-layer owned-fragment manifest in the state directory', () => {
    const state = '/tmp/ocbox-state'
    expect(manifestFile(state)).toBe('/tmp/ocbox-state/agents/codex/manifest.json')
    expect(manifestBackupDirectory(state)).toBe('/tmp/ocbox-state/agents/codex/backups')
    expect(manifestPathForLayer(state, 'user')).toBe(
      '/tmp/ocbox-state/agents/codex/user/manifest.json',
    )
    const manifest = {
      schemaVersion: 1,
      adapter: 'codex',
      layer: 'user',
      codexVersion: '0.153.4',
      schemaRevision: 'codex-cli-0.153',
      representation: 'hooks-json',
      configPath: '/home/ada/.codex/config.toml',
      hooksPath: '/home/ada/.codex/hooks.json',
      sessionId: 'sess-1',
      fragments: [],
      configSha256: null,
      hooksSha256: null,
      configCreated: false,
      hooksCreated: true,
      backupConfigPath: null,
      backupHooksPath: null,
      installedAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
    }
    expect(CodexManifestSchema.parse(manifest).sessionId).toBe('sess-1')
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

  it('normalizes extended-length and mixed-separator project keys', () => {
    expect(normalizeProjectKey('\\\\?\\C:\\Users\\Ada\\Repo')).toBe('c:/users/ada/repo')
    expect(normalizeProjectKey('c:/users/ada/repo/')).toBe('c:/users/ada/repo')
  })

  it('reads a trusted project without ever writing trust', () => {
    const config = '[projects.\'\\\\?\\C:\\Users\\Ada\\Repo\']\ntrust_level = "trusted"\n'
    expect(determineProjectTrust(config, 'C:\\Users\\Ada\\Repo')).toBe('trusted')
    expect(
      determineProjectTrust(
        '[projects.\'C:\\Users\\Ada\\Repo\']\ntrust_level = "untrusted"\n',
        'C:\\Users\\Ada\\Repo',
      ),
    ).toBe('untrusted')
    expect(determineProjectTrust('model = "x"\n', 'C:\\Users\\Ada\\Repo')).toBe('unknown')
  })
})

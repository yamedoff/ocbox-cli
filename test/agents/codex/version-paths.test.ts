import { describe, expect, it } from 'vitest'
import {
  LIVE_E2E_BLOCKER,
  PINNED_CODEX_VERSION,
  SUPPORTED_CODEX_VERSIONS,
  assertSupportedCodexVersion,
  checkCodexVersion,
  parseCodexVersion,
  parseCodexVersionText,
} from '../../../src/agents/codex/version.js'
import {
  assertAdapterOwnedPath,
  layerTargetFiles,
  resolveCodexPaths,
} from '../../../src/agents/codex/paths.js'

describe('codex version gate', () => {
  it('pins the shell codex-cli release', () => {
    expect(PINNED_CODEX_VERSION).toBe('0.153.4')
    expect(SUPPORTED_CODEX_VERSIONS).toEqual(['0.153.4'])
  })

  it('parses installed version output shapes', () => {
    expect(parseCodexVersionText('codex-cli 0.153.4')).toBe('0.153.4')
    expect(parseCodexVersionText('codex-cli 0.153.4\n')).toBe('0.153.4')
    expect(parseCodexVersionText('0.153.4')).toBe('0.153.4')
    expect(parseCodexVersionText('')).toBeNull()
    expect(parseCodexVersionText('codex-cli')).toBeNull()
  })

  it('accepts the pinned shell version', () => {
    expect(checkCodexVersion('codex-cli 0.153.4')).toMatchObject({
      detected: '0.153.4',
      status: 'supported',
      remediation: null,
      channel: 'shell',
    })
    expect(assertSupportedCodexVersion(parseCodexVersion('codex-cli 0.153.4')).codexVersion).toBe(
      '0.153.4',
    )
  })

  it('accepts safe build suffixes on the pinned shell version', () => {
    for (const output of [
      'codex-cli 0.153.4 (abc123)',
      'codex-cli 0.153.4 (abc123def456)',
      'codex-cli 0.153.4 (Build 7f3a1c2)',
      'codex-cli 0.153.4+build.5',
      'codex-cli 0.153.4 (abc123)\n',
    ]) {
      expect(checkCodexVersion(output), output).toMatchObject({
        detected: '0.153.4',
        status: 'supported',
        remediation: null,
      })
      expect(parseCodexVersionText(output), output).toBe('0.153.4')
      expect(parseCodexVersion(output).prerelease, output).toBeNull()
    }
  })

  it('still refuses suffixes that hide a prerelease or another version', () => {
    const otherVersion = checkCodexVersion('codex-cli 0.154.0 (abc123)')
    expect(otherVersion.status).toBe('unsupported')
    expect(otherVersion.detected).toBe('0.154.0')
    const nested = checkCodexVersion('codex-cli 0.153.4 (0.200.0)')
    expect(nested.status).toBe('unsupported')
    const prerelease = checkCodexVersion('codex-cli 0.153.4-alpha.1 (abc123)')
    expect(prerelease.status).toBe('unsupported')
    expect(prerelease.prerelease).toBe('alpha.1')
    const trailing = checkCodexVersion('codex-cli 0.153.4 some other text')
    expect(trailing.status).toBe('unsupported')
  })

  it('refuses unsupported shell versions with remediation instead of guessing', () => {
    const check = checkCodexVersion('codex-cli 0.200.0')
    expect(check.status).toBe('unsupported')
    expect(check.detected).toBe('0.200.0')
    expect(check.remediation).toMatch(/0\.153\.4/)
  })

  it('refuses unparsable output with remediation', () => {
    const check = checkCodexVersion('')
    expect(check.status).toBe('unparsable')
    expect(check.detected).toBeNull()
    expect(check.remediation).toMatch(/codex --version/)
  })

  it('refuses a Desktop pre-release explicitly instead of truncating it to the base version', () => {
    const desktop = checkCodexVersion('codex-desktop 0.154.0-alpha.6.2')
    expect(desktop.status).toBe('unsupported')
    expect(desktop.channel).toBe('desktop')
    expect(desktop.remediation).toMatch(/Desktop pre-release/)
    expect(desktop.remediation).toMatch(/codex-cli 0\.153\.4/)
  })

  it('refuses a shell pre-release outside the pin instead of guessing', () => {
    const check = checkCodexVersion('codex-cli 0.154.0-alpha.6.2')
    expect(check.status).toBe('unsupported')
    expect(check.prerelease).toBe('alpha.6.2')
    expect(check.remediation).toMatch(/pre-release/)
  })

  it('names the live E2E blocker', () => {
    expect(LIVE_E2E_BLOCKER).toMatch(/fail-closed/)
  })
})

describe('codex path resolution', () => {
  it('resolves native Windows user paths', () => {
    const paths = resolveCodexPaths({ platform: 'win32', homeDirectory: 'C:\\Users\\Ada' })
    expect(paths.codexHome).toBe('C:\\Users\\Ada\\.codex')
    expect(paths.userConfigFile).toBe('C:\\Users\\Ada\\.codex\\config.toml')
    expect(paths.userHooksFile).toBe('C:\\Users\\Ada\\.codex\\hooks.json')
    expect(paths.userConfigPath).toBe(paths.userConfigFile)
    expect(paths.hostKind).toBe('windows')
  })

  it('honors an absolute CODEX_HOME override', () => {
    const paths = resolveCodexPaths({
      platform: 'win32',
      homeDirectory: 'C:\\Users\\Ada',
      codexHomeEnv: 'D:\\codex-home',
    })
    expect(paths.codexHome).toBe('D:\\codex-home')
  })

  it('ignores a relative CODEX_HOME override', () => {
    const paths = resolveCodexPaths({
      platform: 'linux',
      homeDirectory: '/home/ada',
      codexHomeEnv: 'relative/path',
    })
    expect(paths.codexHome).toBe('/home/ada/.codex')
  })

  it('resolves Linux, macOS, and WSL hosts', () => {
    expect(resolveCodexPaths({ platform: 'linux', homeDirectory: '/home/ada' }).hostKind).toBe(
      'linux',
    )
    expect(
      resolveCodexPaths({ platform: 'linux', homeDirectory: '/home/ada', isWsl: true }).hostKind,
    ).toBe('wsl')
    expect(resolveCodexPaths({ platform: 'darwin', homeDirectory: '/Users/ada' }).hostKind).toBe(
      'macos',
    )
  })

  it('resolves project layer files under .codex', () => {
    const paths = resolveCodexPaths({
      platform: 'linux',
      homeDirectory: '/home/ada',
      projectDirectory: '/srv/repo',
    })
    expect(paths.projectConfigFile).toBe('/srv/repo/.codex/config.toml')
    expect(paths.projectHooksFile).toBe('/srv/repo/.codex/hooks.json')
    expect(layerTargetFiles(paths, 'user').configFile).toBe('/home/ada/.codex/config.toml')
    expect(layerTargetFiles(paths, 'project').configFile).toBe('/srv/repo/.codex/config.toml')
  })

  it('requires a project directory for the project layer', () => {
    const paths = resolveCodexPaths({ platform: 'linux', homeDirectory: '/home/ada' })
    expect(() => layerTargetFiles(paths, 'project')).toThrow(/project directory/)
  })

  it('requires a home directory', () => {
    expect(() => resolveCodexPaths({ platform: 'linux', homeDirectory: '' })).toThrow(
      /home directory/,
    )
  })

  it('derives per-layer manifest and backup paths from the state directory', () => {
    const paths = resolveCodexPaths({
      platform: 'linux',
      homeDirectory: '/home/ada',
      environment: {},
      stateDirectory: '/state',
    })
    expect(paths.manifestPath('user')).toBe('/state/agents/codex/user/manifest.json')
    expect(paths.backupPath('/home/ada/.codex/hooks.json', '2026-09-12T00:00:00.000Z')).toBe(
      '/home/ada/.codex/hooks.json.2026-09-12T00-00-00-000Z.ocbox-backup',
    )
  })

  it('refuses adapter writes that escape the Codex root', () => {
    expect(() =>
      assertAdapterOwnedPath('/home/ada/.codex/../../etc/passwd', '/home/ada/.codex', 'linux'),
    ).toThrow()
    expect(() =>
      assertAdapterOwnedPath('/home/ada/.codex/hooks.json', '/home/ada/.codex', 'linux'),
    ).not.toThrow()
  })

  it('asserts project-layer targets against the project root on Windows and POSIX', () => {
    const win = resolveCodexPaths({
      platform: 'win32',
      homeDirectory: 'C:\\Users\\Ada',
      projectDirectory: 'C:\\repo',
    })
    expect(() =>
      assertAdapterOwnedPath(win.projectConfigFile ?? '', win.codexHome, 'win32'),
    ).toThrow()
    expect(() =>
      assertAdapterOwnedPath(win.projectConfigFile ?? '', win.projectRoot ?? '', 'win32'),
    ).not.toThrow()
    expect(() =>
      assertAdapterOwnedPath(win.projectHooksFile ?? '', win.projectRoot ?? '', 'win32'),
    ).not.toThrow()

    const posixPaths = resolveCodexPaths({
      platform: 'linux',
      homeDirectory: '/home/ada',
      projectDirectory: '/srv/repo',
    })
    expect(() =>
      assertAdapterOwnedPath(posixPaths.projectConfigFile ?? '', posixPaths.codexHome, 'linux'),
    ).toThrow()
    expect(() =>
      assertAdapterOwnedPath(
        posixPaths.projectConfigFile ?? '',
        posixPaths.projectRoot ?? '',
        'linux',
      ),
    ).not.toThrow()
  })
})

import { describe, expect, it } from 'vitest'
import {
  LIVE_E2E_BLOCKER,
  PINNED_CODEX_VERSION,
  SUPPORTED_CODEX_VERSIONS,
  checkCodexVersion,
  parseCodexVersionText,
} from '../../../src/agents/codex/version.js'
import { layerTargetFiles, resolveCodexPaths } from '../../../src/agents/codex/paths.js'

describe('codex version gate', () => {
  it('pins the locally installed version', () => {
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

  it('accepts the pinned version', () => {
    expect(checkCodexVersion('codex-cli 0.153.4')).toMatchObject({
      detected: '0.153.4',
      status: 'supported',
      remediation: null,
    })
  })

  it('refuses unsupported versions with remediation instead of guessing', () => {
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

  it('refuses a pre-release outside the pin instead of guessing', () => {
    expect(parseCodexVersionText('codex-cli 0.154.0-alpha.6.2')).toBe('0.154.0')
    expect(checkCodexVersion('codex-cli 0.154.0-alpha.6.2').status).toBe('unsupported')
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
})

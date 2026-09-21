import { describe, expect, it } from 'vitest'
import { resolvePlatformPaths } from '../../src/platform/index.js'

describe('platform path resolution', () => {
  it('uses native Windows roaming and local roots', () => {
    expect(
      resolvePlatformPaths({
        platform: 'win32',
        homeDirectory: 'C:\\Users\\Ada',
        environment: {
          APPDATA: 'D:\\Roaming',
          LOCALAPPDATA: 'D:\\Local',
        },
        isWsl: false,
      }),
    ).toMatchObject({
      configDirectory: 'D:\\Roaming\\OpenCloudBox',
      stateDirectory: 'D:\\Local\\OpenCloudBox',
      credentialDirectory: 'D:\\Local\\OpenCloudBox\\Credentials',
      hostKind: 'windows',
      fallbacksUsed: [],
    })
  })

  it('documents Windows fallback selection when environment roots are absent', () => {
    const paths = resolvePlatformPaths({
      platform: 'win32',
      homeDirectory: 'C:\\Users\\Ada',
      environment: {},
      isWsl: false,
    })
    expect(paths.configDirectory).toBe('C:\\Users\\Ada\\AppData\\Roaming\\OpenCloudBox')
    expect(paths.fallbacksUsed).toEqual(['APPDATA', 'LOCALAPPDATA'])
  })

  it('uses XDG roots on Linux and documented home fallbacks otherwise', () => {
    const xdg = resolvePlatformPaths({
      platform: 'linux',
      homeDirectory: '/home/ada',
      environment: {
        XDG_CONFIG_HOME: '/srv/config',
        XDG_STATE_HOME: '/srv/state',
        XDG_CACHE_HOME: '/srv/cache',
      },
      isWsl: false,
    })
    expect(xdg).toMatchObject({
      configDirectory: '/srv/config/ocbox',
      stateDirectory: '/srv/state/ocbox',
      cacheDirectory: '/srv/cache/ocbox',
      hostKind: 'linux',
    })

    const fallback = resolvePlatformPaths({
      platform: 'linux',
      homeDirectory: '/home/ada',
      environment: {},
      isWsl: false,
    })
    expect(fallback.stateDirectory).toBe('/home/ada/.local/state/ocbox')
    expect(fallback.fallbacksUsed).toEqual(['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'])
  })

  it('distinguishes a WSL Windows mount and disables protected-file credentials there', () => {
    const paths = resolvePlatformPaths({
      platform: 'linux',
      homeDirectory: '/mnt/c/Users/Ada',
      environment: {},
      isWsl: true,
    })
    expect(paths.hostKind).toBe('wsl-windows-mount')
    expect(paths.credentialFallbackSafe).toBe(false)
    expect(paths.credentialDirectory).toBeNull()

    const distroPaths = resolvePlatformPaths({
      platform: 'linux',
      homeDirectory: '/home/ada',
      environment: {},
      isWsl: true,
    })
    expect(distroPaths.hostKind).toBe('wsl')
    expect(distroPaths.credentialFallbackSafe).toBe(true)
  })

  it('uses macOS Application Support and Caches conventions', () => {
    expect(
      resolvePlatformPaths({
        platform: 'darwin',
        homeDirectory: '/Users/ada',
        environment: {},
        isWsl: false,
      }),
    ).toMatchObject({
      configDirectory: '/Users/ada/Library/Application Support/OpenCloudBox',
      stateDirectory: '/Users/ada/Library/Application Support/OpenCloudBox',
      cacheDirectory: '/Users/ada/Library/Caches/OpenCloudBox',
      hostKind: 'macos',
    })
  })
})

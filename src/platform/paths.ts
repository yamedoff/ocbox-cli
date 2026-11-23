import { homedir, platform } from 'node:os'
import { posix, win32 } from 'node:path'

export type SupportedHostPlatform = 'darwin' | 'linux' | 'win32'
export type HostEnvironment = Readonly<Record<string, string | undefined>>

export interface PlatformPathContext {
  readonly platform: SupportedHostPlatform
  readonly homeDirectory: string
  readonly environment: HostEnvironment
  readonly isWsl: boolean
}

export interface PlatformPaths {
  readonly configDirectory: string
  readonly stateDirectory: string
  readonly cacheDirectory: string
  /** Null when protected-file credentials would land on an unsafe WSL Windows mount. */
  readonly credentialDirectory: string | null
  readonly credentialFallbackSafe: boolean
  readonly hostKind: 'linux' | 'macos' | 'windows' | 'wsl' | 'wsl-windows-mount'
  readonly fallbacksUsed: readonly string[]
}

function absoluteOrFallback(
  candidate: string | undefined,
  fallback: string,
  isAbsolute: (value: string) => boolean,
  fallbackName: string,
  fallbacks: string[],
): string {
  if (candidate !== undefined && candidate.length > 0 && isAbsolute(candidate)) return candidate
  fallbacks.push(fallbackName)
  return fallback
}

function resolveWindowsPaths(context: PlatformPathContext): PlatformPaths {
  const fallbacks: string[] = []
  const roamingFallback = win32.join(context.homeDirectory, 'AppData', 'Roaming')
  const localFallback = win32.join(context.homeDirectory, 'AppData', 'Local')
  const roaming = absoluteOrFallback(
    context.environment['APPDATA'],
    roamingFallback,
    win32.isAbsolute,
    'APPDATA',
    fallbacks,
  )
  const local = absoluteOrFallback(
    context.environment['LOCALAPPDATA'],
    localFallback,
    win32.isAbsolute,
    'LOCALAPPDATA',
    fallbacks,
  )
  const configDirectory = win32.join(roaming, 'OpenCloudBox')
  const stateDirectory = win32.join(local, 'OpenCloudBox')
  return {
    configDirectory,
    stateDirectory,
    cacheDirectory: win32.join(stateDirectory, 'Cache'),
    credentialDirectory: win32.join(stateDirectory, 'Credentials'),
    credentialFallbackSafe: true,
    hostKind: 'windows',
    fallbacksUsed: fallbacks,
  }
}

function isWslWindowsMount(value: string): boolean {
  return /^\/mnt\/[a-z](?:\/|$)/i.test(posix.normalize(value))
}

function resolveLinuxPaths(context: PlatformPathContext): PlatformPaths {
  const fallbacks: string[] = []
  const configRoot = absoluteOrFallback(
    context.environment['XDG_CONFIG_HOME'],
    posix.join(context.homeDirectory, '.config'),
    posix.isAbsolute,
    'XDG_CONFIG_HOME',
    fallbacks,
  )
  const stateRoot = absoluteOrFallback(
    context.environment['XDG_STATE_HOME'],
    posix.join(context.homeDirectory, '.local', 'state'),
    posix.isAbsolute,
    'XDG_STATE_HOME',
    fallbacks,
  )
  const cacheRoot = absoluteOrFallback(
    context.environment['XDG_CACHE_HOME'],
    posix.join(context.homeDirectory, '.cache'),
    posix.isAbsolute,
    'XDG_CACHE_HOME',
    fallbacks,
  )
  const stateDirectory = posix.join(stateRoot, 'ocbox')
  const unsafeWslMount = context.isWsl && isWslWindowsMount(stateDirectory)
  return {
    configDirectory: posix.join(configRoot, 'ocbox'),
    stateDirectory,
    cacheDirectory: posix.join(cacheRoot, 'ocbox'),
    credentialDirectory: unsafeWslMount ? null : posix.join(stateDirectory, 'credentials'),
    credentialFallbackSafe: !unsafeWslMount,
    hostKind: unsafeWslMount ? 'wsl-windows-mount' : context.isWsl ? 'wsl' : 'linux',
    fallbacksUsed: fallbacks,
  }
}

function resolveMacosPaths(context: PlatformPathContext): PlatformPaths {
  const applicationSupport = posix.join(context.homeDirectory, 'Library', 'Application Support')
  const configDirectory = posix.join(applicationSupport, 'OpenCloudBox')
  return {
    configDirectory,
    stateDirectory: configDirectory,
    cacheDirectory: posix.join(context.homeDirectory, 'Library', 'Caches', 'OpenCloudBox'),
    credentialDirectory: posix.join(configDirectory, 'Credentials'),
    credentialFallbackSafe: true,
    hostKind: 'macos',
    fallbacksUsed: [],
  }
}

/** Deterministically resolves host-local paths from an injectable platform snapshot. */
export function resolvePlatformPaths(context: PlatformPathContext): PlatformPaths {
  if (context.homeDirectory.length === 0) throw new TypeError('A home directory is required')
  switch (context.platform) {
    case 'win32':
      return resolveWindowsPaths(context)
    case 'linux':
      return resolveLinuxPaths(context)
    case 'darwin':
      return resolveMacosPaths(context)
  }
}

function detectWsl(environment: HostEnvironment): boolean {
  return environment['WSL_DISTRO_NAME'] !== undefined || environment['WSL_INTEROP'] !== undefined
}

/** Runtime adapter; tests should inject `PlatformPathContext` directly instead. */
export function resolveCurrentPlatformPaths(
  environment: HostEnvironment = process.env,
): PlatformPaths {
  const currentPlatform = platform()
  if (currentPlatform !== 'win32' && currentPlatform !== 'linux' && currentPlatform !== 'darwin') {
    throw new TypeError(`Unsupported host platform: ${currentPlatform}`)
  }
  return resolvePlatformPaths({
    platform: currentPlatform,
    homeDirectory: homedir(),
    environment,
    isWsl: currentPlatform === 'linux' && detectWsl(environment),
  })
}

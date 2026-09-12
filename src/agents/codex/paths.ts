import { posix, win32 } from 'node:path'

export type CodexHostPlatform = 'darwin' | 'linux' | 'win32'

export type CodexLayer = 'user' | 'project'

export interface CodexPathInputs {
  readonly platform: CodexHostPlatform
  readonly homeDirectory: string
  readonly codexHomeEnv?: string | undefined
  readonly projectDirectory?: string | undefined
  readonly isWsl?: boolean | undefined
}

export interface CodexPaths {
  readonly codexHome: string
  readonly userConfigFile: string
  readonly userHooksFile: string
  readonly projectDirectory: string | null
  readonly projectConfigFile: string | null
  readonly projectHooksFile: string | null
  readonly hostKind: 'linux' | 'macos' | 'windows' | 'wsl'
}

function isAbsoluteFor(platform: CodexHostPlatform, value: string): boolean {
  return platform === 'win32' ? win32.isAbsolute(value) : posix.isAbsolute(value)
}

function joinFor(platform: CodexHostPlatform, ...segments: string[]): string {
  return platform === 'win32' ? win32.join(...segments) : posix.join(...segments)
}

export function resolveCodexPaths(inputs: CodexPathInputs): CodexPaths {
  if (inputs.homeDirectory.length === 0) throw new TypeError('A home directory is required')
  const env = inputs.codexHomeEnv
  const codexHome =
    env !== undefined && env.length > 0 && isAbsoluteFor(inputs.platform, env)
      ? env
      : joinFor(inputs.platform, inputs.homeDirectory, '.codex')
  const projectDirectory =
    inputs.projectDirectory !== undefined && inputs.projectDirectory.length > 0
      ? inputs.projectDirectory
      : null
  return {
    codexHome,
    userConfigFile: joinFor(inputs.platform, codexHome, 'config.toml'),
    userHooksFile: joinFor(inputs.platform, codexHome, 'hooks.json'),
    projectDirectory,
    projectConfigFile:
      projectDirectory === null
        ? null
        : joinFor(inputs.platform, projectDirectory, '.codex', 'config.toml'),
    projectHooksFile:
      projectDirectory === null
        ? null
        : joinFor(inputs.platform, projectDirectory, '.codex', 'hooks.json'),
    hostKind:
      inputs.platform === 'win32'
        ? 'windows'
        : inputs.platform === 'darwin'
          ? 'macos'
          : inputs.isWsl === true
            ? 'wsl'
            : 'linux',
  }
}

export function layerTargetFiles(
  paths: CodexPaths,
  layer: CodexLayer,
): { readonly configFile: string; readonly hooksFile: string } {
  if (layer === 'project') {
    if (paths.projectConfigFile === null || paths.projectHooksFile === null) {
      throw new TypeError('The project layer requires a project directory')
    }
    return { configFile: paths.projectConfigFile, hooksFile: paths.projectHooksFile }
  }
  return { configFile: paths.userConfigFile, hooksFile: paths.userHooksFile }
}

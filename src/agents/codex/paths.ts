import { lstat as nodeLstat, realpath as nodeRealpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import {
  assertPathWithinDirectoryRoot,
  type PathLstat,
  type PathRealpath,
  PathBoundaryViolation,
} from '../../security/path-boundary.js'
import { CodexAdapterError } from './errors.js'

export type CodexHostPlatform = 'darwin' | 'linux' | 'win32'

export type CodexLayer = 'user' | 'project'

export interface CodexPathInputs {
  readonly platform: CodexHostPlatform
  readonly homeDirectory: string
  readonly codexHomeEnv?: string | undefined
  readonly projectDirectory?: string | undefined
  readonly isWsl?: boolean | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly stateDirectory?: string | undefined
  readonly projectRoot?: string | undefined
}

export interface CodexPaths {
  readonly codexHome: string
  readonly userConfigFile: string
  readonly userHooksFile: string
  readonly userConfigPath: string
  readonly userHooksPath: string
  readonly projectDirectory: string | null
  readonly projectRoot: string | null
  readonly projectConfigFile: string | null
  readonly projectHooksFile: string | null
  readonly projectConfigPath: string | null
  readonly projectHooksPath: string | null
  readonly hostKind: 'linux' | 'macos' | 'windows' | 'wsl'
  readonly platform: CodexHostPlatform
  readonly manifestDirectory: string
  readonly manifestPath: (layer: CodexLayer) => string
  readonly backupPath: (targetPath: string, timestamp: string) => string
}

export type CodexAdapterPaths = CodexPaths

export interface CodexPathContext {
  readonly platform: CodexHostPlatform
  readonly homeDirectory: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly stateDirectory: string
  readonly projectRoot?: string
}

function separator(platform: CodexHostPlatform): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix
}

function isAbsoluteFor(platform: CodexHostPlatform, value: string): boolean {
  return separator(platform).isAbsolute(value)
}

function joinFor(platform: CodexHostPlatform, ...segments: string[]): string {
  return separator(platform).join(...segments)
}

function sanitizeTimestamp(timestamp: string): string {
  return timestamp.replaceAll(/[:.]/g, '-')
}

export function resolveCodexPaths(inputs: CodexPathInputs | CodexPathContext): CodexPaths {
  const platform = inputs.platform
  if (inputs.homeDirectory.length === 0) throw new TypeError('A home directory is required')
  const path = separator(platform)
  const envHome =
    'codexHomeEnv' in inputs && inputs.codexHomeEnv !== undefined
      ? inputs.codexHomeEnv
      : 'environment' in inputs
        ? inputs.environment?.['CODEX_HOME']
        : undefined
  const codexHome =
    envHome !== undefined && envHome.length > 0 && isAbsoluteFor(platform, envHome)
      ? envHome
      : joinFor(platform, inputs.homeDirectory, '.codex')
  const projectDirectory =
    ('projectDirectory' in inputs &&
    inputs.projectDirectory !== undefined &&
    inputs.projectDirectory.length > 0
      ? inputs.projectDirectory
      : null) ??
    ('projectRoot' in inputs && inputs.projectRoot !== undefined && inputs.projectRoot.length > 0
      ? inputs.projectRoot
      : null)
  const stateDirectory =
    'stateDirectory' in inputs && inputs.stateDirectory !== undefined ? inputs.stateDirectory : ''
  if (stateDirectory.length > 0 && !isAbsoluteFor(platform, stateDirectory)) {
    throw new TypeError('The adapter state directory must be absolute')
  }
  const manifestDirectory =
    stateDirectory.length === 0 ? '' : path.join(stateDirectory, 'agents', 'codex')
  const projectDotCodex = projectDirectory === null ? null : path.join(projectDirectory, '.codex')
  const userConfigFile = joinFor(platform, codexHome, 'config.toml')
  const userHooksFile = joinFor(platform, codexHome, 'hooks.json')
  return {
    codexHome,
    userConfigFile,
    userHooksFile,
    userConfigPath: userConfigFile,
    userHooksPath: userHooksFile,
    projectDirectory,
    projectRoot: projectDirectory,
    projectConfigFile: projectDotCodex === null ? null : path.join(projectDotCodex, 'config.toml'),
    projectHooksFile: projectDotCodex === null ? null : path.join(projectDotCodex, 'hooks.json'),
    projectConfigPath: projectDotCodex === null ? null : path.join(projectDotCodex, 'config.toml'),
    projectHooksPath: projectDotCodex === null ? null : path.join(projectDotCodex, 'hooks.json'),
    hostKind:
      platform === 'win32'
        ? 'windows'
        : platform === 'darwin'
          ? 'macos'
          : ('isWsl' in inputs && inputs.isWsl === true) ||
              (platform === 'linux' &&
                'environment' in inputs &&
                inputs.environment?.['WSL_DISTRO_NAME'] !== undefined)
            ? 'wsl'
            : 'linux',
    platform,
    manifestDirectory,
    manifestPath: (layer) => {
      if (manifestDirectory.length === 0)
        throw new TypeError('The adapter state directory is required for manifest paths')
      return path.join(manifestDirectory, layer, 'manifest.json')
    },
    backupPath: (targetPath, timestamp) =>
      `${targetPath}.${sanitizeTimestamp(timestamp)}.ocbox-backup`,
  }
}

export function layerTargetFiles(
  paths: CodexPaths,
  layer: CodexLayer,
): { readonly configFile: string; readonly hooksFile: string } {
  if (layer === 'project') {
    const config = paths.projectConfigFile ?? paths.projectConfigPath
    const hooks = paths.projectHooksFile ?? paths.projectHooksPath
    if (config === null || hooks === null) {
      throw new TypeError('The project layer requires a project directory')
    }
    return { configFile: config, hooksFile: hooks }
  }
  return { configFile: paths.userConfigFile, hooksFile: paths.userHooksFile }
}

export function assertAdapterOwnedPath(
  candidate: string,
  root: string,
  platform: CodexHostPlatform,
): void {
  const pathApi = separator(platform)
  if (!pathApi.isAbsolute(candidate)) {
    throw new CodexAdapterError({
      code: 'CODEX_UNSAFE_PATH',
      message: 'Adapter refuses to write a non-absolute config path',
      remediation: 'Set an absolute CODEX_HOME or adapter state directory and retry.',
    })
  }
  const normalizedRoot = pathApi.resolve(root)
  const normalizedPath = pathApi.resolve(candidate)
  const relative = pathApi.relative(normalizedRoot, normalizedPath)
  if (relative.startsWith('..') || pathApi.isAbsolute(relative)) {
    throw new CodexAdapterError({
      code: 'CODEX_UNSAFE_PATH',
      message: 'Adapter refuses to write outside the Codex configuration root',
      remediation: 'Restore the default Codex config location and retry.',
    })
  }
}

/**
 * Injectable link-resolution surface so the boundary can be exercised without a
 * real filesystem while the live CLI always resolves through `node:fs`.
 */
export interface CodexPathBoundaryIo {
  readonly realpath: PathRealpath
  readonly lstat: PathLstat
}

export const nodeCodexPathBoundaryIo: CodexPathBoundaryIo = {
  realpath: nodeRealpath,
  lstat: nodeLstat,
}

/**
 * Full Codex-owned path boundary: the lexical `assertAdapterOwnedPath` check
 * first, then the shared realpath/lstat walk that refuses a target whose
 * existing ancestors or target escape the containing configuration directory
 * through a symlink, junction, or Windows reparse point. A target whose
 * descendants do not exist yet still resolves through its deepest existing
 * ancestor, so a fresh `.codex` directory remains creatable.
 */
export async function assertAdapterOwnedPathWithinRoot(
  candidate: string,
  root: string,
  platform: CodexHostPlatform,
  io: CodexPathBoundaryIo = nodeCodexPathBoundaryIo,
): Promise<void> {
  assertAdapterOwnedPath(candidate, root, platform)
  try {
    await assertPathWithinDirectoryRoot(candidate, io.realpath, io.lstat)
  } catch (error) {
    if (error instanceof PathBoundaryViolation) {
      throw new CodexAdapterError({
        code: 'CODEX_UNSAFE_PATH',
        message: `Adapter refuses an unsafe Codex config path: ${error.message}`,
        remediation: 'Restore the default Codex config location and retry.',
      })
    }
    throw error
  }
}

import {
  type ExecutableExecFile,
  type ExecutableExecOptions,
  type ExecutableExecResult,
  type RawProcessRunner,
  type ReadInstalledExecutableVersionOptions,
  defaultExecutableVersionExecutor,
  readInstalledExecutableVersion,
  resolveExecutableOnPath,
} from '../executable-resolution.js'

/**
 * Centralized installed Codex discovery (D4).
 *
 * `setup` and `doctor` need the installed `codex --version` string for the
 * pinned-version gate. The previous local `detectCodexExecutable` probed only
 * `codex`/`codex.exe` on a synthetic separator and launched with `execFile` and
 * no shell, so it could neither discover nor launch the npm `.cmd`/`.bat` shim
 * that a Windows `npm install -g @openai/codex` exposes. This module binds the
 * shared POSIX/Windows resolver and safe shim launcher, so Codex resolves
 * `codex`, `codex.exe`, `codex.cmd`, and `codex.bat` exactly like Claude Code.
 */

export const CODEX_EXECUTABLE_NAME = 'codex' as const
export const CODEX_VERSION_ARGUMENTS = ['--version'] as const
export const CODEX_VERSION_TIMEOUT_MILLISECONDS = 15_000

export type CodexExecResult = ExecutableExecResult
export type CodexExecOptions = ExecutableExecOptions
export type CodexExecFile = ExecutableExecFile

export interface ResolveCodexExecutableOptions {
  readonly platform?: NodeJS.Platform
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly isExecutableFile?: (candidate: string, platform: NodeJS.Platform) => Promise<boolean>
}

export interface ReadInstalledCodexVersionOptions extends ResolveCodexExecutableOptions {
  readonly executable?: string
  readonly execFile?: CodexExecFile
  readonly timeoutMilliseconds?: number
}

/**
 * Resolves the first executable `codex` candidate on `PATH`: the bare POSIX
 * executable (with the executable bit set) or a Windows `codex.exe`/`codex.cmd`/
 * `codex.bat` shim walked in `PATHEXT` order. Returns `null` when none exists.
 */
export function resolveCodexExecutable(
  options: ResolveCodexExecutableOptions = {},
): Promise<string | null> {
  return resolveExecutableOnPath({ executableName: CODEX_EXECUTABLE_NAME, ...options })
}

/**
 * Production executor. Native executables (including `codex.exe`) spawn
 * directly with no shell; a `.cmd`/`.bat` npm shim is launched through
 * `cmd.exe /d /s /c` with a validated, quoted path and the fixed version argv.
 */
export function defaultCodexVersionExecutor(
  platform: NodeJS.Platform = process.platform,
  run?: RawProcessRunner,
): CodexExecFile {
  return defaultExecutableVersionExecutor('Codex', platform, run)
}

/**
 * Reads the installed `codex --version` output, returning `''` on any failure so
 * `checkCodexVersion` reports the real unsupported/unparsable status instead of
 * masking it with a spawn crash on a correct npm Windows install.
 */
export function readInstalledCodexVersion(
  options: ReadInstalledCodexVersionOptions = {},
): Promise<string> {
  const shared: ReadInstalledExecutableVersionOptions = {
    executableName: CODEX_EXECUTABLE_NAME,
    versionArguments: CODEX_VERSION_ARGUMENTS,
    defaultTimeoutMilliseconds: CODEX_VERSION_TIMEOUT_MILLISECONDS,
    displayName: 'Codex',
    ...options,
  }
  return readInstalledExecutableVersion(shared)
}

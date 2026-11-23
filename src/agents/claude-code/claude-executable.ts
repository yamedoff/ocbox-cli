import {
  type ExecutableExecFile,
  type ExecutableExecOptions,
  type ExecutableExecResult,
  type RawProcessRunner,
  type ReadInstalledExecutableVersionOptions,
  defaultExecutableVersionExecutor,
  readInstalledExecutableVersion,
  resolveExecutableOnPath,
  WINDOWS_PATH_EXTENSIONS_DEFAULT,
} from '../executable-resolution.js'

/**
 * Centralized installed Claude Code discovery.
 *
 * `setup`, `doctor`, and `remove` all need the installed `claude --version`
 * string for the pinned-version gate. The shared executable-resolution module
 * owns the POSIX/Windows lookup and the safe shim launch (explicit `PATH` +
 * `PATHEXT` scan, executable-bit check on POSIX, `cmd.exe /d /s /c` with a
 * quoted, metacharacter-refused path on Windows), so this module only binds the
 * Claude-specific executable name, argv, timeout, and refusal label.
 */

export const CLAUDE_EXECUTABLE_NAME = 'claude' as const
export const CLAUDE_VERSION_ARGUMENTS = ['--version'] as const
export const CLAUDE_VERSION_TIMEOUT_MILLISECONDS = 15_000
export { WINDOWS_PATH_EXTENSIONS_DEFAULT }

export type ClaudeExecResult = ExecutableExecResult
export type ClaudeExecOptions = ExecutableExecOptions
export type ClaudeExecFile = ExecutableExecFile

export interface ResolveClaudeExecutableOptions {
  readonly platform?: NodeJS.Platform
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly isExecutableFile?: (candidate: string, platform: NodeJS.Platform) => Promise<boolean>
}

export interface ReadInstalledClaudeVersionOptions extends ResolveClaudeExecutableOptions {
  readonly execFile?: ClaudeExecFile
  readonly timeoutMilliseconds?: number
}

/**
 * Resolves the first executable `claude` candidate on `PATH`. POSIX uses the
 * executable bit; Windows walks `PATHEXT` in declared order (npm shims are
 * typically `claude.cmd`). Returns `null` when no candidate is executable.
 */
export function resolveClaudeExecutable(
  options: ResolveClaudeExecutableOptions = {},
): Promise<string | null> {
  return resolveExecutableOnPath({ executableName: CLAUDE_EXECUTABLE_NAME, ...options })
}

/**
 * Production executor. Native executables are spawned directly with no shell.
 * A Windows `.cmd`/`.bat` shim is launched via `cmd.exe /d /s /c` with the
 * resolved path quoted; the path is rejected first if it contains any character
 * that could escape the command, and the only argument is the fixed
 * `--version`, so nothing untrusted reaches a shell parser.
 */
export function defaultClaudeVersionExecutor(
  platform: NodeJS.Platform = process.platform,
  run?: RawProcessRunner,
): ClaudeExecFile {
  return defaultExecutableVersionExecutor('Claude Code', platform, run)
}

/**
 * Reads the installed `claude --version` output, returning `''` on any failure
 * so the existing pinned-version gate reports an unsupported install rather than
 * masking the real cause behind a crash.
 */
export function readInstalledClaudeVersion(
  options: ReadInstalledClaudeVersionOptions = {},
): Promise<string> {
  const shared: ReadInstalledExecutableVersionOptions = {
    executableName: CLAUDE_EXECUTABLE_NAME,
    versionArguments: CLAUDE_VERSION_ARGUMENTS,
    defaultTimeoutMilliseconds: CLAUDE_VERSION_TIMEOUT_MILLISECONDS,
    displayName: 'Claude Code',
    ...options,
  }
  return readInstalledExecutableVersion(shared)
}

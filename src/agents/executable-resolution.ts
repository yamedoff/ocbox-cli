import { execFile as execFileCallback } from 'node:child_process'
import { access, constants, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

/**
 * Shared installed-CLI discovery and version probing for the coding-agent
 * adapters.
 *
 * Both `claude-code` and `codex` need the installed `--version` string for their
 * pinned-version gate, and both must survive an npm install on Windows, where
 * the executable is a `.cmd`/`.bat` shim that Node's `execFile` cannot launch
 * directly (no PATHEXT resolution, no batch handling). Resolution is therefore
 * explicit and adapter-neutral here:
 *
 *   1. Locate the candidate by scanning `PATH` (plus `PATHEXT` on Windows) with
 *      the target platform's separator rules, so the lookup itself is
 *      unit-testable on any host.
 *   2. Launch the resolved absolute path with a fixed version argv. Native
 *      executables are spawned directly with no shell; a Windows `.cmd`/`.bat`
 *      shim is launched through `cmd.exe /d /s /c` with a validated, quoted
 *      path. No untrusted input is ever interpolated into a shell command string.
 *
 * The adapter modules (`claude-executable.ts`, `codex/executable.ts`) only bind
 * the executable name, version argv, timeout, and human-facing label.
 */

export const WINDOWS_PATH_EXTENSIONS_DEFAULT = '.COM;.EXE;.BAT;.CMD' as const

/** Characters that would let a resolved shim path break out of `cmd.exe`. */
const UNSAFE_WINDOWS_SHIM_PATH = /["&|<>^%\r\n\0]/
/** Arguments must be shell-neutral before they are joined into a `cmd.exe` line. */
const WINDOWS_SAFE_ARGUMENT = /^[A-Za-z0-9_.:/=@+-]+$/
const WINDOWS_COMMAND_EXTENSION = /\.(?:cmd|bat)$/i

export interface ExecutableExecResult {
  readonly stdout: string
  readonly stderr: string
}

export interface ExecutableExecOptions {
  readonly timeoutMilliseconds: number
}

/**
 * Injected process runner. `args` is always a fixed version-probe argv and
 * `options` deliberately has no `shell` field, so a caller cannot reintroduce
 * shell interpolation of an untrusted value.
 */
export type ExecutableExecFile = (
  executable: string,
  args: readonly string[],
  options: ExecutableExecOptions,
) => Promise<ExecutableExecResult>

/**
 * Raw runner shape used only to inject the low-level spawn in tests. Unlike
 * `ExecutableExecFile`, the third parameter is the bare timeout, matching what
 * the production `execFile` call site consumes.
 */
export type RawProcessRunner = (
  executable: string,
  args: readonly string[],
  timeoutMilliseconds: number,
) => Promise<ExecutableExecResult>

export interface ResolveExecutableOptions {
  readonly executableName: string
  readonly platform?: NodeJS.Platform
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly isExecutableFile?: (candidate: string, platform: NodeJS.Platform) => Promise<boolean>
}

export interface ReadInstalledExecutableVersionOptions extends ResolveExecutableOptions {
  readonly versionArguments: readonly string[]
  readonly defaultTimeoutMilliseconds: number
  /** Human-facing name used only in refusal diagnostics. */
  readonly displayName: string
  /** Pre-resolved absolute executable; skips a second PATH scan when supplied. */
  readonly executable?: string
  readonly execFile?: ExecutableExecFile
  readonly timeoutMilliseconds?: number
}

async function defaultIsExecutableFile(
  candidate: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    const stats = await stat(candidate)
    if (!stats.isFile()) return false
    if (platform === 'win32') return true
    await access(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Windows environment variable names are case-insensitive; the host process may
 * expose `Path`/`PATHEXT` in any casing, so all documented spellings are tried.
 */
function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string {
  for (const name of names) {
    const value = environment[name]
    if (value !== undefined && value.length > 0) return value
  }
  return ''
}

function windowsExtensions(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const raw = environmentValue(environment, ['PATHEXT', 'PathExt'])
  const source = raw.length > 0 ? raw : WINDOWS_PATH_EXTENSIONS_DEFAULT
  return source
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0)
}

/**
 * Resolves the first executable candidate on `PATH`. POSIX uses the executable
 * bit; Windows walks `PATHEXT` in declared order (npm shims are typically
 * `.cmd`). Returns `null` when no candidate is executable.
 */
export async function resolveExecutableOnPath(
  options: ResolveExecutableOptions,
): Promise<string | null> {
  const platform = options.platform ?? process.platform
  const environment = options.environment ?? process.env
  const isExecutableFile = options.isExecutableFile ?? defaultIsExecutableFile

  const windows = platform === 'win32'
  const pathValue = environmentValue(environment, ['PATH', 'Path'])
  if (pathValue.length === 0) return null

  const pathModule = windows ? win32 : posix
  const separator = windows ? ';' : ':'
  const extensions = windows ? windowsExtensions(environment) : ['']
  const seen = new Set<string>()

  for (const directory of pathValue.split(separator)) {
    if (directory.length === 0) continue
    for (const extension of extensions) {
      const candidate = pathModule.join(directory, `${options.executableName}${extension}`)
      const key = windows ? candidate.toLowerCase() : candidate
      if (seen.has(key)) continue
      seen.add(key)
      if (await isExecutableFile(candidate, platform)) return candidate
    }
  }
  return null
}

function runProcess(
  executable: string,
  args: readonly string[],
  timeoutMilliseconds: number,
): Promise<ExecutableExecResult> {
  return new Promise((resolve, reject) => {
    execFileCallback(
      executable,
      [...args],
      { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: timeoutMilliseconds, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(error)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}

/**
 * Production executor factory. Native executables are spawned directly with no
 * shell. A Windows `.cmd`/`.bat` shim is launched via `cmd.exe /d /s /c` with
 * the resolved path quoted; the path is rejected first if it contains any
 * character that could escape the command, and every argument must match a
 * shell-neutral allowlist, so nothing untrusted reaches a shell parser.
 */
export function defaultExecutableVersionExecutor(
  displayName: string,
  platform: NodeJS.Platform = process.platform,
  run: RawProcessRunner = runProcess,
): ExecutableExecFile {
  return async (executable, args, options) => {
    if (platform === 'win32' && WINDOWS_COMMAND_EXTENSION.test(executable)) {
      if (UNSAFE_WINDOWS_SHIM_PATH.test(executable)) {
        throw new Error(
          `Refusing to launch a ${displayName} shim whose path contains shell metacharacters`,
        )
      }
      for (const argument of args) {
        if (!WINDOWS_SAFE_ARGUMENT.test(argument)) {
          throw new Error(
            `Refusing to interpolate an unsafe argument into a ${displayName} shim command`,
          )
        }
      }
      return await run(
        'cmd.exe',
        ['/d', '/s', '/c', `"${executable}" ${args.join(' ')}`],
        options.timeoutMilliseconds,
      )
    }
    return await run(executable, args, options.timeoutMilliseconds)
  }
}

/**
 * Reads an installed binary's `--version` output, returning `''` on any failure
 * so the pinned-version gate reports an unsupported install rather than masking
 * the real cause behind a crash.
 */
export async function readInstalledExecutableVersion(
  options: ReadInstalledExecutableVersionOptions,
): Promise<string> {
  const platform = options.platform ?? process.platform
  const executable = options.executable ?? (await resolveExecutableOnPath(options))
  if (executable === null) return ''

  const executor =
    options.execFile ?? defaultExecutableVersionExecutor(options.displayName, platform)
  try {
    const result = await executor(executable, [...options.versionArguments], {
      timeoutMilliseconds: options.timeoutMilliseconds ?? options.defaultTimeoutMilliseconds,
    })
    return `${result.stdout}${result.stderr}`.trim()
  } catch {
    return ''
  }
}

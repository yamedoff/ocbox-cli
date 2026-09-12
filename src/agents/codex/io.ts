import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { resolve } from 'node:path'
import { projectIdForPath } from '../../lifecycle/index.js'
import { CodexManifestSchema, type CodexManifest } from './manifest.js'
import { resolveCodexPaths, type CodexHostPlatform, type CodexPaths } from './paths.js'

export interface SessionSelection {
  readonly sessionId: string | null
  readonly recorded: boolean
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function currentPlatform(): CodexHostPlatform {
  const current = platform()
  if (current === 'win32' || current === 'darwin' || current === 'linux') return current
  throw new TypeError(`Unsupported host platform: ${current}`)
}

export interface AgentPathOptions {
  readonly codexHome?: string | undefined
  readonly projectDir?: string | undefined
}

export function resolveAgentCodexPaths(options: AgentPathOptions): CodexPaths {
  const codexHomeEnv = options.codexHome ?? process.env['CODEX_HOME']
  return resolveCodexPaths({
    platform: currentPlatform(),
    homeDirectory: homedir(),
    ...(codexHomeEnv === undefined ? {} : { codexHomeEnv }),
    projectDirectory: resolve(options.projectDir ?? process.cwd()),
    isWsl: currentPlatform() === 'linux' && process.env['WSL_DISTRO_NAME'] !== undefined,
  })
}

export function detectCodexExecutable(
  pathValue: string | undefined = process.env['Path'] ?? process.env['PATH'],
): string | null {
  if (pathValue === undefined || pathValue.length === 0) return null
  const separator = pathValue.includes(';') ? ';' : ':'
  for (const directory of pathValue.split(separator)) {
    for (const candidate of [`${directory}/codex`, `${directory}/codex.exe`]) {
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

export function runCodexVersion(executable = 'codex'): Promise<string> {
  return new Promise((resolveVersion) => {
    execFile(executable, ['--version'], { timeout: 15_000 }, (error, stdout) => {
      if (error !== null) resolveVersion('')
      else resolveVersion(String(stdout))
    })
  })
}

export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function readManifestSafe(
  path: string,
): Promise<{ readonly manifest: CodexManifest | null; readonly warning: string | null }> {
  const text = await readTextOrNull(path)
  if (text === null) return { manifest: null, warning: null }
  try {
    const parsed: unknown = JSON.parse(text)
    return { manifest: CodexManifestSchema.parse(parsed), warning: null }
  } catch {
    return {
      manifest: null,
      warning: 'Adapter manifest is corrupted; treating setup as not applied.',
    }
  }
}

export async function resolveSessionSelection(
  stateDirectory: string,
  projectDirectory: string,
  explicitSessionId: string | undefined,
): Promise<SessionSelection> {
  if (explicitSessionId !== undefined && explicitSessionId.length > 0) {
    const recorded = await isSessionRecorded(stateDirectory, projectDirectory, explicitSessionId)
    return { sessionId: explicitSessionId, recorded }
  }
  const stateFile = lifecycleStateFile(stateDirectory, projectDirectory)
  const text = await readTextOrNull(stateFile)
  if (text === null) return { sessionId: null, recorded: false }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { sessionId: null, recorded: false }
    }
    const record = parsed as Record<string, unknown>
    const active = record['activeSessionId']
    if (typeof active !== 'string' || active.length === 0)
      return { sessionId: null, recorded: false }
    const sessions = record['sessions']
    const recorded =
      sessions !== null && typeof sessions === 'object' && !Array.isArray(sessions)
        ? Object.hasOwn(sessions as Record<string, unknown>, active)
        : false
    return { sessionId: active, recorded }
  } catch {
    return { sessionId: null, recorded: false }
  }
}

async function isSessionRecorded(
  stateDirectory: string,
  projectDirectory: string,
  sessionId: string,
): Promise<boolean> {
  const text = await readTextOrNull(lifecycleStateFile(stateDirectory, projectDirectory))
  if (text === null) return false
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const sessions = (parsed as Record<string, unknown>)['sessions']
    return (
      sessions !== null &&
      typeof sessions === 'object' &&
      !Array.isArray(sessions) &&
      Object.hasOwn(sessions as Record<string, unknown>, sessionId)
    )
  } catch {
    return false
  }
}

function lifecycleStateFile(stateDirectory: string, projectDirectory: string): string {
  return `${stateDirectory}/lifecycle/${projectIdForPath(resolve(projectDirectory))}.json`
}

export function projectTrustLevel(
  tomlText: string | null,
  candidates: readonly string[],
  parse: (text: string) => Record<string, unknown>,
): string | null {
  if (tomlText === null) return null
  let document: Record<string, unknown>
  try {
    document = parse(tomlText)
  } catch {
    return null
  }
  const projects = document['projects']
  if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) return null
  const table = projects as Record<string, unknown>
  for (const candidate of candidates) {
    const entry = table[candidate]
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const level = (entry as Record<string, unknown>)['trust_level']
      if (typeof level === 'string') return level
    }
  }
  return null
}

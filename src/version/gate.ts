import { newRequestId } from '../auth/errors.js'
import { OcboxError } from '../errors/index.js'
import { DEFAULT_API_URL } from '../providers/ocbox/defaults.js'
import { cliVersion } from './current.js'
import { isVersionOlder, parseVersion } from './version.js'

/** Path the hosted API answers with its client-compatibility contract. */
export const API_META_PATH = '/v1/meta'
export const API_META_TIMEOUT_MILLISECONDS = 1_500

export interface VersionGateOptions {
  readonly apiUrl?: string | undefined
  readonly currentVersion?: string | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly timeoutMilliseconds?: number | undefined
}

export interface VersionGateResult {
  readonly status: 'current' | 'outdated' | 'unknown' | 'skipped'
  readonly currentVersion: string
  readonly minimumVersion?: string | undefined
  readonly message?: string | undefined
}

interface OutdatedState {
  readonly minimumVersion: string
  readonly message: string
}

let outdated: OutdatedState | undefined

/** Test-only reset for the process-scoped gate state. */
export function resetVersionGate(): void {
  outdated = undefined
}

/**
 * One clear sentence naming the exact command that fixes an old CLI. This is
 * the only text the gate prints, so it must stay copy-pasteable.
 */
export function outdatedVersionMessage(currentVersion: string, minimumVersion: string): string {
  return (
    `ocbox ${currentVersion} is older than the minimum supported version ` +
    `${minimumVersion}; run: ocbox update`
  )
}

function loopbackHost(apiUrl: string): boolean {
  try {
    const host = new URL(apiUrl).hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

function apiBase(apiUrl: string): string {
  // The issuer is normally an origin, but tolerate a base that already ends in
  // `/v1`, exactly as the sizes request does.
  return apiUrl
    .trim()
    .replace(/\/v1\/?$/, '')
    .replace(/\/+$/, '')
}

/**
 * Reads `minCliVersion` from the API's meta answer. Anything other than a
 * well-formed answer leaves the gate open: an unreachable or older API must
 * never block local work or a command the API itself would accept.
 */
export async function checkCliVersionGate(
  options: VersionGateOptions = {},
): Promise<VersionGateResult> {
  const currentVersion = options.currentVersion ?? cliVersion()
  const apiUrl = options.apiUrl ?? DEFAULT_API_URL
  // A loopback API is the local test harness, which publishes no compatibility
  // contract; asking it would add a request to every offline command.
  if (loopbackHost(apiUrl) || parseVersion(currentVersion) === undefined) {
    outdated = undefined
    return { status: 'skipped', currentVersion }
  }
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    outdated = undefined
    return { status: 'unknown', currentVersion }
  }
  let minimumVersion: string | undefined
  try {
    const response = await fetchImpl(`${apiBase(apiUrl)}${API_META_PATH}`, {
      headers: {
        accept: 'application/json',
        'user-agent': `ocbox-cli/${currentVersion}`,
      },
      signal: AbortSignal.timeout(options.timeoutMilliseconds ?? API_META_TIMEOUT_MILLISECONDS),
    })
    if (!response.ok) {
      outdated = undefined
      return { status: 'unknown', currentVersion }
    }
    const body: unknown = await response.json()
    if (body !== null && typeof body === 'object' && 'minCliVersion' in body) {
      const value = (body as { minCliVersion?: unknown }).minCliVersion
      if (typeof value === 'string' && parseVersion(value) !== undefined) {
        minimumVersion = value.trim()
      }
    }
  } catch {
    outdated = undefined
    return { status: 'unknown', currentVersion }
  }
  if (minimumVersion === undefined) {
    outdated = undefined
    return { status: 'unknown', currentVersion }
  }
  if (!isVersionOlder(currentVersion, minimumVersion)) {
    outdated = undefined
    return { status: 'current', currentVersion, minimumVersion }
  }
  const message = outdatedVersionMessage(currentVersion, minimumVersion)
  outdated = { minimumVersion, message }
  return { status: 'outdated', currentVersion, minimumVersion, message }
}

/**
 * Refuses an API request once the startup gate has established that this CLI
 * is below the server's minimum. Local commands never call this, so they keep
 * their exit status while still printing the startup notice.
 */
export function assertCliVersionSupported(): void {
  if (outdated === undefined) return
  throw new OcboxError({
    code: 'CAPABILITY_UNSUPPORTED',
    message: outdated.message,
    requestId: newRequestId(),
  })
}

/** Resolves the API base from the raw command line before oclif parses flags. */
export function apiUrlFromArgv(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): string {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined || token === '--') break
    const inline = /^--api-url=(.*)$/.exec(token)
    if (inline !== null && inline[1] !== undefined) return inline[1]
    if (token === '--api-url') return argv[index + 1] ?? DEFAULT_API_URL
  }
  // Environment is an index signature; bracket access is required by TypeScript.
  // biome-ignore lint/complexity/useLiteralKeys: see explanation above
  return environment['OCBOX_API_URL'] ?? DEFAULT_API_URL
}

import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/** Non-secret inputs that define one warm-session daemon's cache scope. */
export interface WarmSessionScope {
  readonly apiUrl: string
  readonly projectId: string
  readonly stateDirectory: string
}

export interface WarmSocketPathOptions {
  readonly environment?: NodeJS.ProcessEnv | undefined
  readonly platform?: NodeJS.Platform | undefined
  readonly userId?: number | undefined
}

/** Keeps a Unix socket path inside the platform's sockaddr limit. */
const MAX_UNIX_SOCKET_PATH_BYTES = 100

function runtimeRoots(environment: NodeJS.ProcessEnv): string[] {
  const roots: string[] = []
  // Environment is an index signature; bracket access is required by TypeScript.
  // biome-ignore lint/complexity/useLiteralKeys: see explanation above
  const configured = environment['XDG_RUNTIME_DIR']
  if (configured !== undefined && isAbsolute(configured)) roots.push(configured)
  roots.push(tmpdir(), '/tmp')
  return [...new Set(roots)]
}

function userSuffix(userId: number | undefined): string {
  return userId === undefined ? 'user' : String(userId)
}

/**
 * One daemon per API/project/state scope. The path never embeds the URL or a
 * token; only a truncated digest does, and the containing directory is
 * owner-only.
 */
export function warmSocketPath(
  scope: WarmSessionScope,
  options: WarmSocketPathOptions = {},
): string {
  const platform = options.platform ?? process.platform
  const hash = createHash('sha256')
    .update([scope.apiUrl, scope.projectId, scope.stateDirectory].join('\0'))
    .digest('hex')
    .slice(0, 24)
  if (platform === 'win32') return `\\\\.\\pipe\\ocbox-warm-${hash}`
  const suffix = userSuffix(options.userId ?? process.getuid?.())
  for (const root of runtimeRoots(options.environment ?? process.env)) {
    const candidate = join(root, `ocbox-${suffix}`, `warm-${hash}.sock`)
    if (Buffer.byteLength(candidate) <= MAX_UNIX_SOCKET_PATH_BYTES) return candidate
  }
  // Every candidate was too long; let the caller fail closed rather than
  // silently sharing another user's socket.
  return join('/tmp', `ocbox-${suffix}`, `warm-${hash}.sock`)
}

/** The owner-only directory that holds a Unix warm-session socket. */
export function warmSocketDirectory(socketPath: string): string {
  return dirname(socketPath)
}

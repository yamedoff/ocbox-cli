import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Raised when a settings target resolves outside the settings root the adapter
 * is allowed to own. The most common trigger is a repository shipping `.claude`
 * as a directory junction/symlink/reparse point, or a symlinked settings file,
 * that points somewhere outside the project (or user home) settings root.
 */
export class ClaudeSettingsPathBoundaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeSettingsPathBoundaryError'
  }
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : null
}

/**
 * Minimal shape of the `lstat` stat object this module needs.
 *
 * Cross-platform note: Node reports POSIX symlinks and Windows directory
 * junctions with `isSymbolicLink() === true`, which is how a dangling link is
 * recognized. Other Windows reparse points (for example volume mount points or
 * AppExec links) are not distinguishable through the portable `fs.Stats` API;
 * this check covers symlinks and junctions, and a dangling non-junction reparse
 * point still fails closed through the typed write path rather than resolving
 * as if it were absent. POSIX file symlinks are refused here; the committed
 * file-symlink test is skipped on Windows because non-privileged Windows hosts
 * cannot create file symlinks. Junction/symlink directory tests run on both
 * Windows and POSIX.
 */
export interface ClaudeSettingsLinkStats {
  isSymbolicLink(): boolean
}

export type ClaudeSettingsLstat = (path: string) => Promise<ClaudeSettingsLinkStats>

/**
 * Resolves a possibly-not-yet-created path by walking up to the deepest existing
 * ancestor, taking its real (link-resolved) path, then re-appending the missing
 * segments. This is what lets the boundary check reason about a target file that
 * setup is about to create inside a directory that may itself be a link.
 *
 * A `realpath` failure normally means the segment does not exist yet, so the
 * walk continues upward. But a *dangling* symlink/junction/reparse point also
 * fails `realpath` (ENOENT) while still existing as a link entry, and walking
 * past it would let a path resolve as if the link were absent. When `lstat` is
 * supplied, the link entry is detected and refused with the typed boundary
 * error instead of producing a raw `ENOENT` write later.
 */
async function resolveExistingAncestor(
  path: string,
  realpath: (path: string) => Promise<string>,
  lstat?: ClaudeSettingsLstat,
): Promise<string> {
  const absolute = resolve(path)
  const tail: string[] = []
  let cursor = absolute
  for (;;) {
    try {
      const real = await realpath(cursor)
      return tail.length === 0 ? real : join(real, ...tail)
    } catch (error) {
      const code = errorCode(error)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const stat = lstat === undefined ? null : await lstat(cursor).catch(() => null)
      if (stat?.isSymbolicLink()) {
        throw new ClaudeSettingsPathBoundaryError(
          `Refusing to operate on "${path}": "${cursor}" is a symlink, junction, or reparse point whose target cannot be resolved (dangling link). ` +
            'A ".claude" directory or settings file that is a dangling link is not followed.',
        )
      }
      const parent = dirname(cursor)
      if (parent === cursor) return absolute
      tail.unshift(basename(cursor))
      cursor = parent
    }
  }
}

/**
 * Refuses to operate on `targetPath` when its link-resolved location escapes the
 * expected settings root. The expected root is derived from the target's own
 * layout — `<anchor>/.claude` — where the anchor is the project directory
 * (project/local scopes) or the user home (user scope). The anchor's real path
 * is resolved first, so a project directory that is itself a link is followed
 * to its true location, but a `.claude` segment that is a link escaping that
 * location is rejected.
 */
export async function assertSettingsPathWithinRoot(
  targetPath: string,
  realpath: (path: string) => Promise<string>,
  lstat?: ClaudeSettingsLstat,
): Promise<void> {
  const settingsRoot = dirname(targetPath)
  const anchor = dirname(settingsRoot)
  const [realAnchor, realTarget] = await Promise.all([
    resolveExistingAncestor(anchor, realpath, lstat),
    resolveExistingAncestor(targetPath, realpath, lstat),
  ])
  const expectedRoot = join(realAnchor, basename(settingsRoot))
  if (!isWithin(realTarget, expectedRoot)) {
    throw new ClaudeSettingsPathBoundaryError(
      `Refusing to operate on "${targetPath}": it resolves to "${realTarget}", outside the expected settings root "${expectedRoot}". ` +
        'A ".claude" directory or settings file that is a symlink, junction, or reparse point escaping the project/user settings root is not followed.',
    )
  }
}

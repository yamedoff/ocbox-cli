import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Minimal shape of the `lstat` stat object this module needs.
 *
 * Cross-platform note: Node reports POSIX symlinks and Windows directory
 * junctions with `isSymbolicLink() === true`, which is how a dangling link is
 * recognized. Other Windows reparse points (for example volume mount points or
 * AppExec links) are not distinguishable through the portable `fs.Stats` API;
 * this check covers symlinks and junctions, and a dangling non-junction reparse
 * point still fails closed through the adapter's typed write path rather than
 * resolving as if it were absent. POSIX file symlinks are refused here; the
 * committed file-symlink tests are skipped on Windows because non-privileged
 * Windows hosts cannot create file symlinks. Junction/symlink directory tests
 * run on both Windows and POSIX.
 */
export interface PathLinkStats {
  isSymbolicLink(): boolean
}

export type PathRealpath = (path: string) => Promise<string>
export type PathLstat = (path: string) => Promise<PathLinkStats>

export type PathBoundaryViolationReason = 'dangling-link' | 'escapes-root'

/**
 * Low-level refusal raised by the shared path boundary. Adapters wrap this in
 * their own typed error so callers keep a stable adapter-specific error code.
 */
export class PathBoundaryViolation extends Error {
  readonly reason: PathBoundaryViolationReason
  readonly targetPath: string
  readonly resolvedTarget: string | null
  readonly expectedRoot: string | null
  readonly linkPath: string | null

  constructor(input: {
    readonly reason: PathBoundaryViolationReason
    readonly targetPath: string
    readonly message: string
    readonly resolvedTarget?: string
    readonly expectedRoot?: string
    readonly linkPath?: string
  }) {
    super(input.message)
    this.name = 'PathBoundaryViolation'
    this.reason = input.reason
    this.targetPath = input.targetPath
    this.resolvedTarget = input.resolvedTarget ?? null
    this.expectedRoot = input.expectedRoot ?? null
    this.linkPath = input.linkPath ?? null
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
export async function resolveExistingAncestor(
  path: string,
  realpath: PathRealpath,
  lstat?: PathLstat,
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
        throw new PathBoundaryViolation({
          reason: 'dangling-link',
          targetPath: path,
          linkPath: cursor,
          message: `Refusing to operate on "${path}": "${cursor}" is a symlink, junction, or reparse point whose target cannot be resolved (dangling link).`,
        })
      }
      const parent = dirname(cursor)
      if (parent === cursor) return absolute
      tail.unshift(basename(cursor))
      cursor = parent
    }
  }
}

export interface ResolvedWithinRoot {
  readonly targetPath: string
  readonly resolvedTarget: string
  readonly expectedRoot: string
}

/**
 * Refuses to operate on `targetPath` when its link-resolved location escapes the
 * directory that contains it. The containing directory is the protected root;
 * its anchor (parent) is link-resolved first so a project directory reached
 * through a symlink is followed, but the root segment itself (for example
 * `.claude`, `.codex`, or a `CODEX_HOME` override) is not.
 */
export async function assertPathWithinDirectoryRoot(
  targetPath: string,
  realpath: PathRealpath,
  lstat?: PathLstat,
): Promise<ResolvedWithinRoot> {
  const root = dirname(targetPath)
  const anchor = dirname(root)
  const [realAnchor, resolvedTarget] = await Promise.all([
    resolveExistingAncestor(anchor, realpath, lstat),
    resolveExistingAncestor(targetPath, realpath, lstat),
  ])
  const expectedRoot = join(realAnchor, basename(root))
  if (!isWithin(resolvedTarget, expectedRoot)) {
    throw new PathBoundaryViolation({
      reason: 'escapes-root',
      targetPath,
      resolvedTarget,
      expectedRoot,
      message: `Refusing to operate on "${targetPath}": it resolves to "${resolvedTarget}", outside the expected root "${expectedRoot}".`,
    })
  }
  return { targetPath, resolvedTarget, expectedRoot }
}

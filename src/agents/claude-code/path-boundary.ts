import {
  assertPathWithinDirectoryRoot,
  type PathLstat,
  type PathRealpath,
  PathBoundaryViolation,
} from '../../security/path-boundary.js'

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

/**
 * Minimal shape of the `lstat` stat object this module needs (kept exported for
 * compatibility with callers that referenced it before the shared boundary).
 */
export interface ClaudeSettingsLinkStats {
  isSymbolicLink(): boolean
}

export type ClaudeSettingsLstat = PathLstat

function settingsGuidance(violation: PathBoundaryViolation): string {
  return violation.reason === 'dangling-link'
    ? 'A ".claude" directory or settings file that is a dangling symlink, junction, or reparse point is not followed.'
    : 'A ".claude" directory or settings file that is a symlink, junction, or reparse point escaping the project/user settings root is not followed.'
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
  realpath: PathRealpath,
  lstat?: ClaudeSettingsLstat,
): Promise<void> {
  try {
    await assertPathWithinDirectoryRoot(targetPath, realpath, lstat)
  } catch (error) {
    if (error instanceof PathBoundaryViolation) {
      throw new ClaudeSettingsPathBoundaryError(`${error.message} ${settingsGuidance(error)}`)
    }
    throw error
  }
}

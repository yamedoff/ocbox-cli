import type { Stats } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join, matchesGlob, resolve } from 'node:path'
import ignore from 'ignore'
import {
  builtInExclusion,
  type ExclusionReason,
  type IgnoreRule,
  parseIgnoreRules,
} from './exclusions.js'
import type { ManifestPath } from './path-policy.js'

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  // A worktree root has a `.git` file rather than a directory, so
  // `.git/info/exclude` reports ENOTDIR instead of ENOENT.
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function readRuleFile(
  root: string,
  name: string,
  source: IgnoreRule['source'],
): Promise<readonly IgnoreRule[]> {
  let contents: string
  try {
    contents = await readFile(join(root, name), 'utf8')
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  return parseIgnoreRules(contents, source, { allowAnchored: true })
}

/** The subset of the `ignore` matcher this module needs, kept local so the public declarations never import the package. */
interface GitignoreMatcher {
  test(path: string): { readonly ignored: boolean; readonly unignored: boolean }
}

/**
 * Resolves the git directory that holds the repository config and the shared
 * `info/exclude`. A normal checkout has a `.git` directory; a linked worktree
 * has a `.git` file pointing at a worktree git directory whose `commondir`
 * file names the common directory. Reading these files avoids invoking git.
 */
async function gitCommonDirectory(root: string): Promise<string | null> {
  const dotGit = join(root, '.git')
  let metadata: Stats
  try {
    metadata = await lstat(dotGit)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  if (metadata.isDirectory()) return dotGit
  if (!metadata.isFile()) return null
  let contents: string
  try {
    contents = await readFile(dotGit, 'utf8')
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(contents)?.[1]
  if (gitdir === undefined) return null
  const worktreeGitDirectory = isAbsolute(gitdir) ? gitdir : resolve(root, gitdir)
  try {
    const common = (await readFile(join(worktreeGitDirectory, 'commondir'), 'utf8')).trim()
    if (common.length === 0) return worktreeGitDirectory
    return isAbsolute(common) ? common : resolve(worktreeGitDirectory, common)
  } catch (error) {
    if (isMissing(error)) return worktreeGitDirectory
    throw error
  }
}

/**
 * Reads `core.ignorecase` from the repository config without invoking git. Git
 * only treats a repository as case-insensitive when the setting says so, and
 * defaults to case-sensitive matching when it is absent.
 */
async function readCoreIgnoreCase(gitDirectory: string | null): Promise<boolean> {
  if (gitDirectory === null) return false
  let contents: string
  try {
    contents = await readFile(join(gitDirectory, 'config'), 'utf8')
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
  let section = ''
  for (const original of contents.split(/\r?\n/)) {
    const line = original.trim()
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[\s*([^\]\s"]+)(?:\s+"[^"]*")?\s*\]$/.exec(line)
    if (header !== null) {
      section = (header[1] ?? '').toLowerCase()
      continue
    }
    if (section !== 'core') continue
    const assignment = /^([^=\s]+)\s*(?:=\s*(.*))?$/.exec(line)
    if (assignment === null || (assignment[1] ?? '').toLowerCase() !== 'ignorecase') continue
    const value = (assignment[2] ?? '').trim().toLowerCase()
    return !['false', 'no', 'off', '0'].includes(value)
  }
  return false
}

async function readGitMatcher(path: string, ignorecase: boolean): Promise<GitignoreMatcher | null> {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  return ignore({ ignorecase }).add(contents)
}

/**
 * The loaded source-side rules. `.gitignore` files are read lazily per folder,
 * so a directory that the scan never enters (built-in or user-ignored) is never
 * inspected, matching git's traversal.
 */
export interface LoadedIgnoreRules {
  readonly root: string
  readonly ignorecase: boolean
  readonly infoExclude: GitignoreMatcher | null
  readonly userRuleGroups: readonly (readonly IgnoreRule[])[]
  readonly gitignoreByFolder: Map<string, Promise<GitignoreMatcher | null>>
}

/**
 * Builds the deterministic precedence chain: built-in exclusions run first and
 * cannot be re-included, then `.git/info/exclude`, then each `.gitignore` from
 * the root down to the path's folder, then `.opencloudboxignore`, then CLI
 * rules. Later groups override earlier user-authored decisions.
 */
export async function loadIgnoreRuleGroups(
  root: string,
  cliRules: readonly IgnoreRule[],
): Promise<LoadedIgnoreRules> {
  const gitDirectory = await gitCommonDirectory(root)
  const ignorecase = await readCoreIgnoreCase(gitDirectory)
  const [infoExclude, opencloudboxignore] = await Promise.all([
    gitDirectory === null
      ? Promise.resolve(null)
      : readGitMatcher(join(gitDirectory, 'info', 'exclude'), ignorecase),
    readRuleFile(root, '.opencloudboxignore', 'opencloudboxignore'),
  ])
  return {
    root,
    ignorecase,
    infoExclude,
    userRuleGroups: [opencloudboxignore, cliRules],
    gitignoreByFolder: new Map(),
  }
}

async function gitignoreFor(
  rules: LoadedIgnoreRules,
  folder: string,
): Promise<GitignoreMatcher | null> {
  const cached = rules.gitignoreByFolder.get(folder)
  if (cached !== undefined) return cached
  const path =
    folder === ''
      ? join(rules.root, '.gitignore')
      : join(rules.root, ...folder.split('/'), '.gitignore')
  const loaded = readGitMatcher(path, rules.ignorecase)
  rules.gitignoreByFolder.set(folder, loaded)
  return loaded
}

/** Applies one `.gitignore` matcher to a path relative to that file's folder. */
function gitDecision(
  matcher: GitignoreMatcher,
  base: string,
  path: ManifestPath,
  isDirectory: boolean,
): 'ignored' | 'unignored' | null {
  if (base !== '' && !path.startsWith(`${base}/`)) return null
  const relative = base === '' ? path : path.slice(base.length + 1)
  const result = matcher.test(isDirectory ? `${relative}/` : relative)
  if (result.ignored) return 'ignored'
  if (result.unignored) return 'unignored'
  return null
}

/**
 * The full source-side exclusion decision. The folder is the raw relative
 * folder that holds `path`; it locates the `.gitignore` files that apply while
 * the normalized path is matched against them.
 */
export async function sourceExclusionForPath(
  rules: LoadedIgnoreRules | undefined,
  folder: string,
  path: ManifestPath,
  isDirectory: boolean,
): Promise<ExclusionReason | null> {
  const builtIn = builtInExclusion(path)
  if (builtIn !== null || rules === undefined) return builtIn
  const normalizedFolder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const rawSegments = folder === '' ? [] : folder.split('/')
  const normalizedSegments = normalizedFolder === '' ? [] : normalizedFolder.split('/')
  let excluded = false
  if (rules.infoExclude !== null) {
    const decision = gitDecision(rules.infoExclude, '', path, isDirectory)
    if (decision === 'ignored') excluded = true
    else if (decision === 'unignored') excluded = false
  }
  for (let depth = 0; depth <= rawSegments.length; depth += 1) {
    const matcher = await gitignoreFor(rules, rawSegments.slice(0, depth).join('/'))
    if (matcher === null) continue
    const decision = gitDecision(
      matcher,
      normalizedSegments.slice(0, depth).join('/'),
      path,
      isDirectory,
    )
    if (decision === 'ignored') excluded = true
    else if (decision === 'unignored') excluded = false
  }
  for (const group of rules.userRuleGroups) {
    for (const rule of group) {
      if (matchesGlob(path, rule.pattern)) excluded = !rule.include
    }
  }
  return excluded ? 'user-rule' : null
}

/** Maps repeatable CLI `--exclude`/`--include` patterns to user ignore rules. */
export function cliRules(
  excludes: readonly string[] = [],
  includes: readonly string[] = [],
): readonly IgnoreRule[] {
  const patterns = [...excludes, ...includes.map((pattern) => `!${pattern}`)]
  return patterns.length === 0
    ? []
    : parseIgnoreRules(patterns.join('\n'), 'cli', { allowAnchored: true })
}

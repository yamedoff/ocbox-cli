import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

class GuardError extends Error {}

export function compilePatterns(value) {
  return value.split(/\r?\n/).flatMap((pattern, offset) => {
    if (!pattern.trim()) return []
    try {
      return [{ regex: new RegExp(pattern, 'i'), index: offset + 1 }]
    } catch {
      // RegExp errors include the expression, so never forward them.
      throw new GuardError(`Invalid pattern at index ${offset + 1}.`)
    }
  })
}

function matches(text, file, line, patterns) {
  return patterns
    .filter(({ regex }) => regex.test(text))
    .map(({ index }) => ({ file, line, pattern: index }))
}

export function scanAddedLines(diff, file, patterns) {
  const findings = []
  let line = null
  for (const text of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      line = Number(hunk[1])
    } else if (line !== null && text.startsWith('+')) {
      findings.push(...matches(text.slice(1), file, line, patterns))
      line += 1
    } else if (line !== null && text.startsWith(' ')) {
      line += 1
    }
  }
  return findings
}

export function eventRange(eventName, event) {
  let base
  let head
  if (eventName === 'pull_request') {
    base = event.pull_request?.base?.sha
    head = event.pull_request?.head?.sha
  } else if (eventName === 'push') {
    base = event.before
    head = event.after
  } else {
    throw new GuardError('Unsupported event.')
  }
  if (![base, head].every((sha) => typeof sha === 'string' && /^[a-f\d]{40}$/i.test(sha))) {
    throw new GuardError('Invalid event commit identifiers.')
  }
  if (/^0+$/.test(head)) return null
  if (/^0+$/.test(base)) {
    if (eventName !== 'push') throw new GuardError('Invalid event base commit.')
    base = null
  }
  return { base, head, mergeBase: eventName === 'pull_request' }
}

function git(cwd, args) {
  // Child processes do not need the secret. Capture stderr without logging it.
  const env = { ...process.env }
  delete env.LEAK_GUARD_PATTERNS
  const result = spawnSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    input: '',
  })
  if (result.error || result.status !== 0)
    throw new GuardError('Unable to read the repository diff.')
  return result.stdout
}

export function scanRepository(cwd, range, patterns) {
  let base = range.base ?? git(cwd, ['hash-object', '-t', 'tree', '--stdin']).trim()
  if (range.mergeBase) {
    if (git(cwd, ['rev-parse', '--is-shallow-repository']).trim() !== 'false')
      throw new GuardError('PR scans require complete repository history.')
    // Resolve the three-dot base once for both the file list and line patches.
    // Never use checkout HEAD: on PR events it can be a synthetic merge commit.
    const bases = git(cwd, ['merge-base', '--all', base, range.head]).trim().split('\n')
    if (bases.length !== 1) throw new GuardError('PR scan requires a unique merge base.')
    base = bases[0]
  }
  const revisions = [base, range.head]
  const options = ['--no-ext-diff', '--no-textconv', '--no-renames', '--no-color']
  const entries = git(cwd, [
    'diff',
    ...options,
    '--name-status',
    '-z',
    '--diff-filter=AMT',
    ...revisions,
    '--',
  ])
    .split('\0')
    .slice(0, -1)
  const findings = []
  for (let offset = 0; offset < entries.length; offset += 2) {
    const status = entries[offset]
    const file = entries[offset + 1]
    // Renames are treated as deletion + addition, covering their new names.
    // Line zero represents a filename rather than file content.
    if (status === 'A') findings.push(...matches(file, file, 0, patterns))
    const diff = git(cwd, [
      'diff',
      ...options,
      '--text',
      '--unified=0',
      ...revisions,
      '--',
      `:(literal)${file}`,
    ])
    findings.push(...scanAddedLines(diff, file, patterns))
  }
  return findings
}

export function scanFullTree(cwd, patterns) {
  cwd = git(cwd, ['rev-parse', '--show-toplevel']).trim()
  const entries = git(cwd, ['ls-files', '--stage', '-z']).split('\0').slice(0, -1)
  const findings = []
  for (const entry of entries) {
    const tab = entry.indexOf('\t')
    const [mode, , stage] = entry.slice(0, tab).split(' ')
    if (stage !== '0') throw new GuardError('Full-tree audit requires a resolved index.')
    // A tracked submodule is a separate repository, not a file in this tree.
    if (mode === '160000') continue
    const file = entry.slice(tab + 1)
    findings.push(...matches(file, file, 0, patterns))
    // Read working-tree bytes so audits include edits before they are committed.
    // Scan symlink targets without following links outside the repository.
    const path = join(cwd, file)
    const contents = lstatSync(path).isSymbolicLink()
      ? readlinkSync(path)
      : readFileSync(path, 'utf8')
    const lines = contents ? contents.split('\n') : []
    if (contents.endsWith('\n')) lines.pop()
    for (const [offset, line] of lines.entries())
      findings.push(...matches(line, file, offset + 1, patterns))
  }
  return findings
}

export function run({ env = process.env, cwd = process.cwd(), log = console.log, argv = [] } = {}) {
  try {
    if (argv.length && (argv.length !== 1 || argv[0] !== '--full-tree'))
      throw new GuardError('Usage: leak-guard.mjs [--full-tree].')
    const fullTree = argv[0] === '--full-tree'
    const value = env.LEAK_GUARD_PATTERNS ?? ''
    if (!value.trim()) {
      if (fullTree) throw new GuardError('Full-tree audit requires patterns.')
      log('::notice::Leak guard skipped: LEAK_GUARD_PATTERNS is unavailable (including fork PRs).')
      return 0
    }
    const patterns = compilePatterns(value)
    let findings
    if (fullTree) {
      findings = scanFullTree(cwd, patterns)
    } else {
      const range = eventRange(
        env.GITHUB_EVENT_NAME,
        JSON.parse(readFileSync(env.GITHUB_EVENT_PATH)),
      )
      if (!range) {
        log('::notice::Leak guard skipped: branch deletion has no added content.')
        return 0
      }
      findings = scanRepository(cwd, range, patterns)
    }
    // JSON escaping prevents filenames from injecting log commands or extra lines.
    for (const finding of findings) log(JSON.stringify(finding))
    return findings.length ? 1 : 0
  } catch (error) {
    log(
      `::error::${error instanceof GuardError ? error.message : 'Leak guard could not complete.'}`,
    )
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run({ argv: process.argv.slice(2) })
}

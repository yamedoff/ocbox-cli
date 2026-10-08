import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { compilePatterns, eventRange, run, scanAddedLines, scanRepository } from './leak-guard.mjs'

const patterns = compilePatterns('forbiddenterm\nmadeup[- ]term')
const sha = '1'.repeat(40)
const zero = '0'.repeat(40)

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'leak-guard-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '--quiet')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '/dev/null')
  const write = (file, contents) => {
    const path = join(cwd, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  const commit = () => {
    git('add', '--all')
    git('commit', '--quiet', '--allow-empty', '-m', 'Fixture')
    return git('rev-parse', 'HEAD')
  }
  const eventEnv = (eventName, event, secret = 'forbiddenterm') => {
    const eventPath = join(cwd, '.git', 'event.json')
    writeFileSync(eventPath, JSON.stringify(event))
    return {
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      LEAK_GUARD_PATTERNS: secret,
    }
  }
  return { cwd, git, write, commit, eventEnv }
}

test('patterns are case insensitive regexes with stable one-based indexes', () => {
  const compiled = compilePatterns('forbiddenterm\r\n\r\nmadeup[- ]term\r\n')
  assert.deepEqual(
    compiled.map(({ index }) => index),
    [1, 3],
  )
  assert(compiled[0].regex.test('FORBIDDENTERM'))
  assert(compiled[1].regex.test('MadeUp-Term'))
  assert(compiled[1].regex.test('MadeUp Term'))
  assert.equal(compilePatterns(' \n\t').length, 0)
  assert(compilePatterns(' forbiddenterm ')[0].regex.test(' forbiddenterm '))
})

test('invalid regex errors expose only the index', () => {
  assert.throws(() => compilePatterns('safe\n(forbiddenterm'), {
    message: 'Invalid pattern at index 2.',
  })
})

test('only added lines match, with destination line numbers across hunks', () => {
  const diff = [
    'diff --git a/forbiddenterm b/forbiddenterm',
    '--- a/forbiddenterm',
    '+++ b/forbiddenterm',
    '@@ -2,2 +2,3 @@',
    '-forbiddenterm',
    ' forbiddenterm',
    '+FORBIDDENTERM and madeup-term',
    '+safe',
    '@@ -10,0 +12,2 @@',
    '+++forbiddenterm',
    '+madeup term',
    '\\ No newline at end of file',
  ].join('\n')
  assert.deepEqual(scanAddedLines(diff, 'example.txt', patterns), [
    { file: 'example.txt', line: 3, pattern: 1 },
    { file: 'example.txt', line: 3, pattern: 2 },
    { file: 'example.txt', line: 12, pattern: 1 },
    { file: 'example.txt', line: 13, pattern: 2 },
  ])
  assert.deepEqual(scanAddedLines('@@ -1 +0,0 @@\n-forbiddenterm', 'example.txt', patterns), [])
})

test('event ranges distinguish PR merge bases, pushes, new branches, and deletions', () => {
  const head = '2'.repeat(40)
  assert.deepEqual(
    eventRange('pull_request', { pull_request: { base: { sha }, head: { sha: head } } }),
    {
      base: sha,
      head,
      mergeBase: true,
    },
  )
  assert.deepEqual(eventRange('push', { before: sha, after: head }), {
    base: sha,
    head,
    mergeBase: false,
  })
  assert.deepEqual(eventRange('push', { before: zero, after: head }), {
    base: null,
    head,
    mergeBase: false,
  })
  assert.equal(eventRange('push', { before: sha, after: zero }), null)
  for (const [name, event] of [
    ['unexpected', {}],
    ['push', { before: 'invalid', after: head }],
    ['pull_request', { pull_request: { base: { sha: zero }, head: { sha: head } } }],
  ]) {
    assert.throws(() => eventRange(name, event))
  }
})

test('missing and empty secrets skip before reading any event or repository', () => {
  for (const value of [undefined, '', ' \r\n\t']) {
    const output = []
    assert.equal(run({ env: { LEAK_GUARD_PATTERNS: value }, log: (line) => output.push(line) }), 0)
    assert.equal(output.length, 1)
    assert.match(output[0], /^::notice::.*skipped.*fork PRs/)
  }
})

test('repository scans ignore existing and deleted terms and honor literal paths', (t) => {
  const repo = repository(t)
  repo.write('existing.txt', 'forbiddenterm\nforbiddenterm\nkeep\n')
  repo.write('removed.txt', 'forbiddenterm\n')
  const base = repo.commit()
  repo.write('existing.txt', 'forbiddenterm\nkeep\nsafe\n')
  rmSync(join(repo.cwd, 'removed.txt'))
  const special = '-[odd]\t"\nfile.txt'
  repo.write(special, 'safe\nForBiddenTerm\n')
  const head = repo.commit()
  assert.deepEqual(scanRepository(repo.cwd, { base, head }, patterns), [
    { file: special, line: 2, pattern: 1 },
  ])
})

test('new and renamed filenames match even with empty or unchanged content', (t) => {
  const repo = repository(t)
  repo.write('original.txt', 'safe\n')
  const base = repo.commit()
  repo.write('empty-FORBIDDENTERM.txt', '')
  renameSync(join(repo.cwd, 'original.txt'), join(repo.cwd, 'madeup-term.txt'))
  const head = repo.commit()
  assert.deepEqual(scanRepository(repo.cwd, { base, head }, patterns), [
    { file: 'empty-FORBIDDENTERM.txt', line: 0, pattern: 1 },
    { file: 'madeup-term.txt', line: 0, pattern: 2 },
  ])
})

test('initial pushes scan the whole tree, including binary additions and symlinks', (t) => {
  const repo = repository(t)
  repo.write('binary.dat', '\0safe\nforbiddenterm\n')
  repo.write('target.txt', 'safe\n')
  symlinkSync('forbiddenterm-target.txt', join(repo.cwd, 'link'))
  const head = repo.commit()
  assert.deepEqual(scanRepository(repo.cwd, { base: null, head }, patterns), [
    { file: 'binary.dat', line: 2, pattern: 1 },
    { file: 'link', line: 1, pattern: 1 },
  ])
})

test('PR diffs ignore base-only changes, and force pushes compare endpoint snapshots', (t) => {
  const repo = repository(t)
  repo.write('common.txt', 'safe\n')
  const common = repo.commit()
  repo.write('base-only.txt', 'forbiddenterm\n')
  const base = repo.commit()
  repo.git('checkout', '--quiet', '--detach', common)
  repo.write('head-only.txt', 'safe\n')
  const head = repo.commit()
  assert.deepEqual(scanRepository(repo.cwd, { base, head, mergeBase: true }, patterns), [])
  repo.git('checkout', '--quiet', '--detach', common)
  repo.write('head-only.txt', 'forbiddenterm\n')
  const after = repo.commit()
  assert.deepEqual(scanRepository(repo.cwd, { base: head, head: after }, patterns), [
    { file: 'head-only.txt', line: 1, pattern: 1 },
  ])
})

test('CLI results contain only paths, line numbers, and indexes; failures are redacted', (t) => {
  const repo = repository(t)
  const base = repo.commit()
  repo.write('example.txt', 'FORBIDDENTERM\n')
  const head = repo.commit()
  const output = []
  const log = (line) => output.push(line)
  const env = repo.eventEnv('push', { before: base, after: head })
  assert.equal(run({ cwd: repo.cwd, env, log }), 1)
  assert.deepEqual(output, ['{"file":"example.txt","line":1,"pattern":1}'])
  output.length = 0
  assert.equal(
    run({ cwd: repo.cwd, env: { ...env, LEAK_GUARD_PATTERNS: '(forbiddenterm' }, log }),
    1,
  )
  assert.deepEqual(output, ['::error::Invalid pattern at index 1.'])
  output.length = 0
  assert.equal(
    run({ cwd: repo.cwd, env: repo.eventEnv('push', { before: sha, after: head }), log }),
    1,
  )
  assert.deepEqual(output, ['::error::Unable to read the repository diff.'])
  output.length = 0
  writeFileSync(env.GITHUB_EVENT_PATH, '{forbiddenterm')
  assert.equal(run({ cwd: repo.cwd, env, log }), 1)
  assert.deepEqual(output, ['::error::Leak guard could not complete.'])
})

test('clean diffs and branch deletion succeed', (t) => {
  const repo = repository(t)
  repo.write('example.txt', 'safe\n')
  const base = repo.commit()
  repo.write('example.txt', 'still safe\n')
  const head = repo.commit()
  const output = []
  const log = (line) => output.push(line)
  assert.equal(
    run({ cwd: repo.cwd, env: repo.eventEnv('push', { before: base, after: head }), log }),
    0,
  )
  assert.deepEqual(output, [])
  assert.equal(
    run({ cwd: repo.cwd, env: repo.eventEnv('push', { before: head, after: zero }), log }),
    0,
  )
  assert.match(output[0], /^::notice::.*branch deletion/)
})

test('the executable exits nonzero without disclosing matching text or invalid patterns', (t) => {
  const repo = repository(t)
  const base = repo.commit()
  repo.write('example.txt', 'forbiddenterm\n')
  const head = repo.commit()
  const result = spawnSync(
    process.execPath,
    [new URL('./leak-guard.mjs', import.meta.url).pathname],
    {
      cwd: repo.cwd,
      env: { ...process.env, ...repo.eventEnv('push', { before: base, after: head }) },
      encoding: 'utf8',
    },
  )
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '{"file":"example.txt","line":1,"pattern":1}\n')
  assert.equal(result.stderr, '')
})

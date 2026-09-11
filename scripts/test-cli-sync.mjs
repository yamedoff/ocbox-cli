import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(repositoryRoot, 'dist', 'index.js')
const root = await mkdtemp(join(tmpdir(), 'ocbox-sync-e2e-'))
const children = new Set()

/**
 * Runs the built CLI and preserves stdout/stderr as exact bytes. stdin is
 * ignored and every child is bounded by a timeout so a prompt regression can
 * never hang the suite; the caller kills and reaps any survivor on teardown.
 */
function run(args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: '1', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    children.add(child)
    const stdout = []
    const stderr = []
    let settled = false
    const finish = (action) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      children.delete(child)
      action()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => rejectPromise(new Error(`CLI timed out: ${args.join(' ')}`)))
    }, options.timeout ?? 30_000)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => finish(() => rejectPromise(error)))
    child.on('close', (code, signal) =>
      finish(() =>
        resolvePromise({
          code,
          signal,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        }),
      ),
    )
  })
}

/** Asserts stdout is exactly one machine-readable envelope and stderr is clean. */
function parseEnvelope(buffer, stream = 'stdout') {
  const text = buffer.toString('utf8')
  assert.notEqual(text.trim(), '', `Expected ${stream} envelope but it was empty`)
  const envelope = JSON.parse(text)
  assert.deepEqual(Object.keys(envelope).sort(), [
    'data',
    'kind',
    'name',
    'schemaVersion',
    'timestamp',
  ])
  assert.equal(envelope.schemaVersion, 1)
  return envelope
}

function assertSingleResultEnvelope(result, name) {
  assert.equal(
    result.stdout
      .toString('utf8')
      .trim()
      .split(/\n(?=\{)/).length,
    1,
    'stdout must contain exactly one JSON envelope',
  )
  assert.equal(result.stderr.toString('utf8'), '', 'stderr must be empty on success')
  const envelope = parseEnvelope(result.stdout)
  assert.equal(envelope.kind, 'result')
  if (name !== undefined) assert.equal(envelope.name, name)
  return envelope
}

/** Asserts a typed failure: non-zero exit, clean stdout, one stderr envelope. */
function assertErrorEnvelope(result, code) {
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  assert.equal(result.stdout.toString('utf8'), '', 'stdout must stay clean on failure')
  const envelope = parseEnvelope(result.stderr, 'stderr')
  assert.equal(envelope.kind, 'error')
  assert.equal(envelope.data.code, code)
  return envelope
}

async function workspace(name) {
  const directory = join(root, name)
  const project = join(directory, 'project')
  const local = join(directory, 'local')
  const remote = join(directory, 'remote')
  await mkdir(project, { recursive: true })
  await mkdir(local, { recursive: true })
  await mkdir(remote, { recursive: true })
  const state = join(project, 'state')
  const config = join(project, 'opencloudbox.toml')
  const runtime = ['--config', config, '--state-dir', state]
  const sync = ['--local-dir', local, '--remote-dir', remote]
  return { directory, project, local, remote, state, config, runtime, sync }
}

async function initAndStart(space) {
  await run(['init', ...space.runtime, '--json'], { cwd: space.project })
  const started = await run(['start', ...space.runtime, '--json'], { cwd: space.project })
  assert.equal(started.code, 0, 'start must succeed')
  return parseEnvelope(started.stdout).data.session.id
}

function adapterState(space) {
  return join(dirname(space.remote), `.${basename(space.remote)}.ocbox-sync-state`)
}

try {
  // 1. Command registration and help.
  const help = await run(['sync', '--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout.toString('utf8'), /sync diff/)
  assert.match(help.stdout.toString('utf8'), /sync push/)
  assert.match(help.stdout.toString('utf8'), /sync pull/)
  const diffHelp = await run(['sync', 'diff', '--help'])
  assert.equal(diffHelp.code, 0)
  assert.match(diffHelp.stdout.toString('utf8'), /--session/)

  // 2. Session target resolution: missing selection fails typed.
  const empty = await workspace('empty')
  await run(['init', ...empty.runtime, '--json'], { cwd: empty.project })
  const missing = await run(['sync', 'diff', ...empty.runtime, ...empty.sync, '--json'], {
    cwd: empty.project,
  })
  assertErrorEnvelope(missing, 'ENVIRONMENT_NOT_FOUND')

  // 3. First sync diff, push, idempotency, and JSON cleanliness.
  const basic = await workspace('basic')
  const sessionId = await initAndStart(basic)
  await writeFile(join(basic.local, 'value.txt'), 'content')
  await mkdir(join(basic.local, 'nested'))
  await writeFile(join(basic.local, 'nested', 'deep.txt'), 'deep')

  const diff = assertSingleResultEnvelope(
    await run(['sync', 'diff', ...basic.runtime, ...basic.sync, '--json'], { cwd: basic.project }),
    'sync.diff',
  )
  assert.equal(diff.data.sessionId, sessionId)
  assert.equal(diff.data.firstSync, true)
  assert.equal(diff.data.additions.length, 3)

  const pushed = assertSingleResultEnvelope(
    await run(['sync', 'push', '--session', sessionId, ...basic.runtime, ...basic.sync, '--json'], {
      cwd: basic.project,
    }),
    'sync.pushed',
  )
  assert.equal(pushed.data.applied, true)
  assert.equal(await readFile(join(basic.remote, 'value.txt'), 'utf8'), 'content')
  assert.equal(await readFile(join(basic.remote, 'nested', 'deep.txt'), 'utf8'), 'deep')

  const idempotent = assertSingleResultEnvelope(
    await run(['sync', 'push', ...basic.runtime, ...basic.sync, '--json'], { cwd: basic.project }),
    'sync.pushed',
  )
  assert.equal(idempotent.data.applied, false)

  // 4. Pull a remote modification into the local target.
  await writeFile(join(basic.remote, 'nested', 'deep.txt'), 'deep-remote')
  const pulled = assertSingleResultEnvelope(
    await run(['sync', 'pull', ...basic.runtime, ...basic.sync, '--json'], { cwd: basic.project }),
    'sync.pulled',
  )
  assert.equal(pulled.data.applied, true)
  assert.equal(await readFile(join(basic.local, 'nested', 'deep.txt'), 'utf8'), 'deep-remote')

  // 5. Conflicts fail closed and preserve both copies.
  await writeFile(join(basic.local, 'value.txt'), 'local-change')
  await writeFile(join(basic.remote, 'value.txt'), 'remote-change')
  const conflictDiff = assertSingleResultEnvelope(
    await run(['sync', 'diff', ...basic.runtime, ...basic.sync, '--json'], { cwd: basic.project }),
    'sync.diff',
  )
  assert.ok(conflictDiff.data.conflicts.length >= 1)
  const conflict = await run(['sync', 'push', ...basic.runtime, ...basic.sync, '--json'], {
    cwd: basic.project,
  })
  assertErrorEnvelope(conflict, 'SYNC_CONFLICT')
  assert.equal(await readFile(join(basic.local, 'value.txt'), 'utf8'), 'local-change')
  assert.equal(await readFile(join(basic.remote, 'value.txt'), 'utf8'), 'remote-change')

  // 6. Delete refusal, confirmation refusal, and --yes acknowledgement.
  const deletions = await workspace('deletions')
  await initAndStart(deletions)
  await writeFile(join(deletions.local, 'remove.txt'), 'remove')
  await writeFile(join(deletions.local, 'keep.txt'), 'keep')
  await run(['sync', 'push', ...deletions.runtime, ...deletions.sync, '--json'], {
    cwd: deletions.project,
  })
  await rm(join(deletions.local, 'remove.txt'))
  const refused = await run(['sync', 'push', ...deletions.runtime, ...deletions.sync, '--json'], {
    cwd: deletions.project,
  })
  assertErrorEnvelope(refused, 'SYNC_CONFLICT')
  const nonTty = await run(
    ['sync', 'push', '--delete', ...deletions.runtime, ...deletions.sync, '--json'],
    { cwd: deletions.project },
  )
  assertErrorEnvelope(nonTty, 'SYNC_CONFLICT')
  const deleted = assertSingleResultEnvelope(
    await run(
      ['sync', 'push', '--delete', '--yes', ...deletions.runtime, ...deletions.sync, '--json'],
      { cwd: deletions.project },
    ),
    'sync.pushed',
  )
  assert.equal(deleted.data.applied, true)
  await assert.rejects(readFile(join(deletions.remote, 'remove.txt')), { code: 'ENOENT' })
  assert.equal(await readFile(join(deletions.remote, 'keep.txt'), 'utf8'), 'keep')

  // 7. Binary content round-trips byte for byte.
  const binary = await workspace('binary')
  await initAndStart(binary)
  const bytes = Buffer.from([0, 255, 1, 128, 10, 0, 42])
  await writeFile(join(binary.local, 'blob.bin'), bytes)
  assertSingleResultEnvelope(
    await run(['sync', 'push', ...binary.runtime, ...binary.sync, '--json'], {
      cwd: binary.project,
    }),
    'sync.pushed',
  )
  assert.deepEqual([...(await readFile(join(binary.remote, 'blob.bin')))], [...bytes])

  // 8. Built-in exclusions are reported but never transferred.
  const exclusions = await workspace('exclusions')
  await initAndStart(exclusions)
  await writeFile(join(exclusions.local, '.env.local'), 'SECRET=1')
  await mkdir(join(exclusions.local, 'node_modules'))
  await writeFile(join(exclusions.local, 'node_modules', 'dep.js'), 'dep')
  await writeFile(join(exclusions.local, 'app.js'), 'app')
  const excluded = assertSingleResultEnvelope(
    await run(['sync', 'diff', ...exclusions.runtime, ...exclusions.sync, '--json'], {
      cwd: exclusions.project,
    }),
    'sync.diff',
  )
  assert.ok(excluded.data.excluded.some((entry) => entry.reason === 'secret-environment'))
  assert.ok(excluded.data.excluded.some((entry) => entry.reason === 'dependency-cache'))
  assertSingleResultEnvelope(
    await run(['sync', 'push', ...exclusions.runtime, ...exclusions.sync, '--json'], {
      cwd: exclusions.project,
    }),
    'sync.pushed',
  )
  await assert.rejects(readFile(join(exclusions.remote, '.env.local')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(exclusions.remote, 'node_modules', 'dep.js')), {
    code: 'ENOENT',
  })
  assert.equal(await readFile(join(exclusions.remote, 'app.js'), 'utf8'), 'app')

  // 9. An invalid ignore pattern is a typed configuration failure.
  const invalidRules = await run(
    ['sync', 'diff', ...exclusions.runtime, ...exclusions.sync, '--exclude', '../escape', '--json'],
    { cwd: exclusions.project },
  )
  assertErrorEnvelope(invalidRules, 'CONFIG_INVALID')

  // 10. Recovery-required state fails closed until recovery is explicit.
  const recovery = await workspace('recovery')
  await initAndStart(recovery)
  await writeFile(join(recovery.local, 'value.txt'), 'v1')
  await run(['sync', 'push', ...recovery.runtime, ...recovery.sync, '--json'], {
    cwd: recovery.project,
  })
  const state = adapterState(recovery)
  await mkdir(join(state, 'stage-00000000-0000-0000-0000-000000000000'), { recursive: true })
  await writeFile(
    join(state, 'journal.json'),
    JSON.stringify({
      schemaVersion: 1,
      operationId: '00000000-0000-0000-0000-000000000000',
      stage: 'staged',
      hadTarget: null,
      stagingDirectory: 'stage-00000000-0000-0000-0000-000000000000',
      backupDirectory: 'backup-00000000-0000-0000-0000-000000000000',
    }),
  )
  const blocked = await run(['sync', 'push', ...recovery.runtime, ...recovery.sync, '--json'], {
    cwd: recovery.project,
  })
  assertErrorEnvelope(blocked, 'SYNC_FAILED')
  const recovered = assertSingleResultEnvelope(
    await run(['sync', 'recover', ...recovery.runtime, ...recovery.sync, '--json'], {
      cwd: recovery.project,
    }),
    'sync.recovered',
  )
  assert.equal(recovered.data.recovered, true)
  const afterRecovery = await run(
    ['sync', 'push', ...recovery.runtime, ...recovery.sync, '--json'],
    {
      cwd: recovery.project,
    },
  )
  assert.equal(afterRecovery.code, 0)

  // 11. A crash between target commit and baseline persistence reconciles on retry.
  const boundary = await workspace('boundary')
  await initAndStart(boundary)
  await writeFile(join(boundary.local, 'value.txt'), 'v1')
  assertSingleResultEnvelope(
    await run(['sync', 'push', ...boundary.runtime, ...boundary.sync, '--json'], {
      cwd: boundary.project,
    }),
    'sync.pushed',
  )
  const stateRoot = join(boundary.state, 'sync')
  const [projectKey] = await readdir(stateRoot)
  const [sessionKey] = await readdir(join(stateRoot, projectKey))
  const persistedBaseline = join(stateRoot, projectKey, sessionKey, 'baseline.json')
  const pendingPath = join(stateRoot, projectKey, sessionKey, 'pending-baseline.json')
  const firstBaseline = JSON.parse(await readFile(persistedBaseline, 'utf8'))

  await writeFile(join(boundary.local, 'value.txt'), 'v2')
  assertSingleResultEnvelope(
    await run(['sync', 'push', ...boundary.runtime, ...boundary.sync, '--json'], {
      cwd: boundary.project,
    }),
    'sync.pushed',
  )
  const secondBaseline = JSON.parse(await readFile(persistedBaseline, 'utf8'))

  // Reproduce a crash after the target commit but before baseline promotion:
  // the target already holds v2 while only the stale v1 baseline is persisted.
  await writeFile(persistedBaseline, JSON.stringify(firstBaseline))
  await writeFile(
    pendingPath,
    JSON.stringify({
      schemaVersion: 1,
      operationId: '88888888-8888-4888-8888-888888888888',
      mode: 'push',
      targetSide: 'remote',
      baseline: secondBaseline,
    }),
  )
  const boundaryRetry = assertSingleResultEnvelope(
    await run(['sync', 'push', ...boundary.runtime, ...boundary.sync, '--json'], {
      cwd: boundary.project,
    }),
    'sync.pushed',
  )
  assert.equal(boundaryRetry.data.applied, false)
  assert.deepEqual(JSON.parse(await readFile(persistedBaseline, 'utf8')), secondBaseline)
  await assert.rejects(readFile(pendingPath), { code: 'ENOENT' })
  assert.equal(await readFile(join(boundary.remote, 'value.txt'), 'utf8'), 'v2')

  // 12. Target mismatch fails closed.
  const mismatch = await workspace('mismatch')
  await initAndStart(mismatch)
  await rm(mismatch.remote, { recursive: true, force: true })
  await writeFile(mismatch.remote, 'not a directory')
  await writeFile(join(mismatch.local, 'value.txt'), 'v1')
  const mismatchResult = await run(
    ['sync', 'push', ...mismatch.runtime, ...mismatch.sync, '--json'],
    { cwd: mismatch.project },
  )
  assertErrorEnvelope(mismatchResult, 'SYNC_CONFLICT')

  process.stdout.write('CLI sync E2E passed\n')
} finally {
  for (const child of children) child.kill('SIGKILL')
  await rm(root, { recursive: true, force: true })
}

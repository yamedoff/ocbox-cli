import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(repositoryRoot, 'dist', 'index.js')
const helper = join(repositoryRoot, 'dist', 'execution-helper.js')
const isWindows = process.platform === 'win32'

/** Runs the built CLI and preserves stdout/stderr as exact bytes. */
function run(args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: '1', ...options.env },
      windowsHide: true,
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', rejectPromise)
    child.on('close', (code, signal) =>
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }),
    )
  })
}

function parseEnvelope(buffer, stream = 'stdout') {
  const text = buffer.toString('utf8').trim()
  assert.notEqual(text, '', `Expected ${stream} envelope but it was empty`)
  return JSON.parse(text)
}

const projectDirectory = await mkdtemp(join(tmpdir(), 'ocbox-exec-e2e-'))
const emptyStateDirectory = await mkdtemp(join(tmpdir(), 'ocbox-exec-empty-'))
const stateDirectory = join(projectDirectory, 'state')
const configPath = join(projectDirectory, 'opencloudbox.toml')
const runtimeFlags = ['--config', configPath, '--state-dir', stateDirectory]
const emptyRuntimeFlags = ['--config', configPath, '--state-dir', emptyStateDirectory]

const marker = 'EXEC-READY'

try {
  // Helper protocol version negotiation is part of the exec wire contract.
  const probe = spawnSync(process.execPath, [helper, '--protocol-version'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  })
  assert.equal(probe.status, 0)
  assert.equal(probe.stdout, '1\n')
  assert.equal(probe.stderr, '')

  const initialized = parseEnvelope(
    (await run(['init', ...runtimeFlags, '--json'], { cwd: projectDirectory })).stdout,
  )
  assert.equal(initialized.data, 'created')
  await run(['init', ...emptyRuntimeFlags, '--json'], { cwd: projectDirectory })

  const started = parseEnvelope(
    (await run(['start', ...runtimeFlags, '--json'], { cwd: projectDirectory })).stdout,
  )
  const sessionId = started.data.session.id
  assert.equal(started.data.session.state, 'active')

  // 1. Registered command is invocable and preserves a nonzero remote exit.
  const nonzero = await run(
    ['exec', '--json', ...runtimeFlags, '--', process.execPath, '-e', 'process.exit(7)'],
    { cwd: projectDirectory },
  )
  assert.equal(nonzero.code, 7)
  const nonzeroEnvelope = parseEnvelope(nonzero.stdout)
  assert.equal(nonzeroEnvelope.outcome, 'remote_result')
  assert.equal(nonzeroEnvelope.result.exitCode, 7)

  // 2. Binary-safe, independently captured stdout/stderr streams.
  const binary = await run(
    [
      'exec',
      ...runtimeFlags,
      '--',
      process.execPath,
      '-e',
      "process.stdout.write(Buffer.from([0,255,1,10]));process.stderr.write(Buffer.from('日本語'))",
    ],
    { cwd: projectDirectory },
  )
  assert.equal(binary.code, 0)
  assert.deepEqual([...binary.stdout], [0, 255, 1, 10])
  assert.equal(binary.stderr.toString('utf8'), '日本語')

  // 3. Explicit `--session` selects that Session's primary Sandbox binding.
  const explicit = await run(
    [
      'exec',
      '--session',
      sessionId,
      ...runtimeFlags,
      '--',
      process.execPath,
      '-e',
      "process.stdout.write('explicit')",
    ],
    { cwd: projectDirectory },
  )
  assert.equal(explicit.code, 0)
  assert.equal(explicit.stdout.toString('utf8'), 'explicit')

  // 4. Non-secret `--env` and a positive `--timeout` validate before execution.
  const environment = await run(
    [
      'exec',
      '--env',
      'OCBOX_E2E=ok',
      '--timeout',
      '30000',
      ...runtimeFlags,
      '--',
      process.execPath,
      '-e',
      'process.stdout.write(process.env.OCBOX_E2E ?? "missing")',
    ],
    { cwd: projectDirectory },
  )
  assert.equal(environment.code, 0)
  assert.equal(environment.stdout.toString('utf8'), 'ok')

  // 5. JSON output is bounded and reports exact truncation metadata.
  const flood = await run(
    [
      'exec',
      '--json',
      ...runtimeFlags,
      '--',
      process.execPath,
      '-e',
      "process.stdout.write('a'.repeat(100000))",
    ],
    { cwd: projectDirectory },
  )
  assert.equal(flood.code, 0)
  const floodEnvelope = parseEnvelope(flood.stdout)
  assert.equal(floodEnvelope.outcome, 'remote_result')
  assert.equal(floodEnvelope.stdout.retainedBytes, 65536)
  assert.equal(floodEnvelope.stdout.totalBytes, 100000)
  assert.equal(floodEnvelope.stdout.truncated, true)

  // 6. Timeout maps to 124 and a typed timeout discriminator.
  const timeout = await run(
    [
      'exec',
      '--timeout',
      '300',
      '--json',
      ...runtimeFlags,
      '--',
      process.execPath,
      '-e',
      'setTimeout(() => {}, 5000)',
    ],
    { cwd: projectDirectory },
  )
  assert.equal(timeout.code, 124)
  assert.equal(parseEnvelope(timeout.stdout).outcome, 'timeout')

  // 7. Missing selection is a typed, actionable before-start failure (never a
  // silent create).
  const missing = await run(
    ['exec', '--json', ...emptyRuntimeFlags, '--', process.execPath, '-e', 'process.exit(0)'],
    { cwd: projectDirectory },
  )
  assert.equal(missing.code, 125)
  const missingEnvelope = parseEnvelope(missing.stdout)
  assert.equal(missingEnvelope.outcome, 'infrastructure_error')
  assert.equal(missingEnvelope.error.code, 'ENVIRONMENT_NOT_FOUND')

  // 8. A terminal/non-active Session is rejected with a typed error and is not
  // replaced.
  await run(['pause', ...runtimeFlags, '--json'], { cwd: projectDirectory })
  const paused = await run(
    ['exec', '--json', ...runtimeFlags, '--', process.execPath, '-e', 'process.exit(0)'],
    { cwd: projectDirectory },
  )
  assert.equal(paused.code, 125)
  assert.equal(parseEnvelope(paused.stdout).error.code, 'INVALID_STATE')
  const afterPause = parseEnvelope(
    (await run(['status', ...runtimeFlags, '--json'], { cwd: projectDirectory })).stdout,
  )
  assert.equal(afterPause.data.session.state, 'paused')
  await run(['start', ...runtimeFlags, '--json'], { cwd: projectDirectory })

  // 9. `--shell` is explicit and mutually exclusive with structured argv.
  const conflict = await run(
    ['exec', '--shell', 'printf nope', ...runtimeFlags, '--', 'printf', 'nope'],
    { cwd: projectDirectory },
  )
  assert.equal(conflict.code, 125)

  if (!isWindows) {
    const shell = await run(['exec', '--shell', 'printf shell-ok', ...runtimeFlags], {
      cwd: projectDirectory,
    })
    assert.equal(shell.code, 0)
    assert.equal(shell.stdout.toString('utf8'), 'shell-ok')

    // 10. First SIGINT requests remote cancellation exactly once and exits 130
    // with a cancelled terminal diagnostic.
    const interrupted = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(
        process.execPath,
        [
          cli,
          'exec',
          ...runtimeFlags,
          '--',
          process.execPath,
          '-e',
          `process.stdout.write('${marker}\\n');setInterval(() => {}, 1000)`,
        ],
        { cwd: projectDirectory, env: { ...process.env, NO_COLOR: '1' }, windowsHide: true },
      )
      const stdout = []
      const stderr = []
      let signalled = false
      child.stdout.on('data', (chunk) => {
        stdout.push(chunk)
        if (!signalled && Buffer.concat(stdout).includes(marker)) {
          signalled = true
          child.kill('SIGINT')
        }
      })
      child.stderr.on('data', (chunk) => stderr.push(chunk))
      child.on('error', rejectPromise)
      child.on('close', (code, signal) =>
        resolvePromise({
          code,
          signal,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        }),
      )
    })
    assert.equal(interrupted.code, 130)
    assert.equal(interrupted.stdout.toString('utf8'), `${marker}\n`)
    assert.match(interrupted.stderr.toString('utf8'), /Execution cancelled/)
  }

  process.stdout.write('CLI exec E2E passed\n')
} finally {
  await rm(projectDirectory, { recursive: true, force: true })
  await rm(emptyStateDirectory, { recursive: true, force: true })
}

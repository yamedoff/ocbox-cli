import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(repositoryRoot, 'dist', 'index.js')

function parseEnvelope(stdout) {
  const envelope = JSON.parse(stdout)
  assert.deepEqual(Object.keys(envelope).sort(), [
    'data',
    'kind',
    'name',
    'schemaVersion',
    'timestamp',
  ])
  assert.equal(envelope.schemaVersion, 1)
  assert.equal(Number.isNaN(Date.parse(envelope.timestamp)), false)
  return envelope
}

async function invoke(cwd, args) {
  return execFileAsync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
}

async function invokeFailure(cwd, args) {
  try {
    await invoke(cwd, args)
    assert.fail(`Expected command to fail: ${args.join(' ')}`)
  } catch (error) {
    assert.equal(typeof error, 'object')
    assert.notEqual(error, null)
    return error
  }
}

const projectDirectory = await mkdtemp(join(tmpdir(), 'ocbox-cli-e2e-'))
const stateDirectory = join(projectDirectory, 'state')
const configPath = join(projectDirectory, 'opencloudbox.toml')
const runtimeFlags = ['--config', configPath, '--state-dir', stateDirectory]

try {
  const initialized = parseEnvelope(
    (await invoke(projectDirectory, ['init', ...runtimeFlags, '--json'])).stdout,
  )
  assert.equal(initialized.name, 'project.initialized')
  assert.equal(initialized.data, 'created')

  const providersOutput = await invoke(projectDirectory, ['providers', ...runtimeFlags, '--jsonl'])
  assert.equal(providersOutput.stdout.trim().split('\n').length, 1)
  const providers = parseEnvelope(providersOutput.stdout)
  assert.equal(providers.name, 'providers.inspected')
  assert.equal(providers.data.configuredProvider, 'fake')
  assert.equal(providers.data.providers[0].auth, 'not_required')
  assert.equal(providers.data.providers[0].capabilities.lifecycle.supportsMemoryPause, true)

  const first = parseEnvelope(
    (await invoke(projectDirectory, ['start', ...runtimeFlags, '--json'])).stdout,
  )
  const firstSessionId = first.data.session.id
  const firstSandboxId = first.data.sandbox.id
  assert.equal(first.data.session.state, 'active')

  const second = parseEnvelope(
    (await invoke(projectDirectory, ['start', '--new', ...runtimeFlags, '--json'])).stdout,
  )
  assert.notEqual(second.data.session.id, firstSessionId)
  assert.notEqual(second.data.sandbox.id, firstSandboxId)

  const listed = parseEnvelope(
    (await invoke(projectDirectory, ['ls', ...runtimeFlags, '--json'])).stdout,
  )
  assert.equal(listed.name, 'sessions.listed')
  assert.equal(listed.data.length, 2)
  assert.equal(listed.data.filter((view) => view.selected).length, 1)

  const selected = parseEnvelope(
    (await invoke(projectDirectory, ['use', firstSessionId, ...runtimeFlags, '--json'])).stdout,
  )
  assert.equal(selected.name, 'session.selected')
  assert.equal(selected.data.session.id, firstSessionId)

  const status = await invoke(projectDirectory, ['status', ...runtimeFlags])
  assert.match(
    status.stdout,
    new RegExp(`^\\* ${firstSessionId} active provider=running raw=fake:RUNNING`),
  )

  const paused = parseEnvelope(
    (await invoke(projectDirectory, ['pause', ...runtimeFlags, '--json'])).stdout,
  )
  assert.equal(paused.data.session.state, 'paused')
  assert.equal(paused.data.sandbox.id, firstSandboxId)

  const stopped = parseEnvelope(
    (await invoke(projectDirectory, ['stop', ...runtimeFlags, '--json'])).stdout,
  )
  assert.equal(stopped.data.session.state, 'stopped')
  assert.equal(stopped.data.sandbox.id, firstSandboxId)

  const restarted = parseEnvelope(
    (await invoke(projectDirectory, ['start', ...runtimeFlags, '--json'])).stdout,
  )
  assert.equal(restarted.data.session.state, 'active')
  assert.equal(restarted.data.sandbox.id, firstSandboxId)

  const declined = await invokeFailure(projectDirectory, ['destroy', ...runtimeFlags, '--json'])
  const declinedEnvelope = parseEnvelope(declined.stderr)
  assert.equal(declinedEnvelope.kind, 'error')
  assert.equal(declinedEnvelope.data.code, 'INVALID_STATE')

  const destroyed = parseEnvelope(
    (await invoke(projectDirectory, ['destroy', '--yes', ...runtimeFlags, '--json'])).stdout,
  )
  assert.equal(destroyed.data.session.state, 'destroyed')
  assert.equal(destroyed.data.sandbox, null)
  assert.notEqual(destroyed.data.session.sandboxDeletionVerifiedAt, null)

  const terminalStart = await invokeFailure(projectDirectory, ['start', ...runtimeFlags, '--json'])
  const terminalEnvelope = parseEnvelope(terminalStart.stderr)
  assert.equal(terminalEnvelope.data.code, 'INVALID_STATE')

  process.stdout.write('CLI lifecycle E2E passed\n')
} finally {
  await rm(projectDirectory, { recursive: true, force: true })
}

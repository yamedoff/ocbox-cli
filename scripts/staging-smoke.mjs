#!/usr/bin/env node
/**
 * Release staging smoke. Drives the installed `ocbox` command through the
 * public happy path — list sizes, start a box, run one command in it, destroy —
 * and always attempts the destroy from a finally step.
 *
 * Self-test (no secrets, fake `ocbox` on PATH):
 *   node scripts/staging-smoke.mjs --self-test
 *
 * Live run (the workflow supplies both secrets):
 *   OCB_STAGING_API_URL=... OCB_STAGING_CLI_TOKEN=... node scripts/staging-smoke.mjs
 *
 * The live path needs the built CLI in this checkout (`pnpm run build`) so it
 * can place the supplied access token in the same protected credential store
 * the CLI reads. It never prints either secret and never prints a size id or a
 * raw HTTP body.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultTimeoutMilliseconds = 120_000
const startTimeoutMilliseconds = 900_000
const destroyTimeoutMilliseconds = 300_000
const maximumOutputBytes = 16 * 1024 * 1024
const runMarkerPattern = /^ocb-smoke-[A-Za-z0-9-]{1,64}$/
const argumentPattern = /^[A-Za-z0-9._:-]{1,128}$/

function fail(message) {
  throw new Error(message)
}

function lastNonEmptyLine(output) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return lines.at(-1) ?? ''
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/**
 * Reads the CLI's own output. `--json` prints one pretty-printed envelope
 * across many lines (src/output/writer.ts), while `--jsonl` prints one compact
 * envelope per line. The whole text is read first and the JSONL stream is the
 * fallback, so neither shape is mistaken for the other.
 */
function jsonDocuments(text) {
  const trimmed = text.trim()
  if (trimmed !== '') {
    const document = parseJsonLine(trimmed)
    if (document !== null) return [document]
  }
  const documents = []
  for (const line of text.split(/\r?\n/)) {
    const candidate = line.trim()
    if (candidate === '') continue
    const document = parseJsonLine(candidate)
    if (document !== null) documents.push(document)
  }
  return documents
}

function errorText(envelope) {
  const data = envelope?.data
  if (data !== null && typeof data === 'object') {
    const code = typeof data.code === 'string' ? data.code : undefined
    const message = typeof data.message === 'string' ? data.message : undefined
    if (code !== undefined && message !== undefined) return `${code}: ${message}`
    if (message !== undefined) return message
  }
  return 'the CLI reported an error'
}

/** Returns the CLI's own error line, never a whole response body. */
export function cliErrorLine(stderr, stdout) {
  for (const document of jsonDocuments(stderr).reverse()) {
    if (document?.kind === 'error') return errorText(document)
  }
  for (const document of jsonDocuments(stdout).reverse()) {
    if (document?.kind === 'error') return errorText(document)
    if (document?.kind === 'result' && document.outcome === 'infrastructure_error') {
      return errorText({ data: document.error })
    }
    if (document?.kind === 'result' && typeof document.result?.exitCode === 'number') {
      return `remote command exited with code ${document.result.exitCode}`
    }
    if (
      document?.kind === 'event' &&
      document.event === 'completed' &&
      typeof document.result?.exitCode === 'number'
    ) {
      return `remote command exited with code ${document.result.exitCode}`
    }
  }
  return lastNonEmptyLine(stderr) || lastNonEmptyLine(stdout) || 'the CLI printed no error line'
}

/** One command failure that names the command, its exit code and the CLI's line. */
export function formatCliFailure(command, result) {
  const timeout = result.timedOut ? ' (timed out)' : ''
  const status = result.status ?? 'none'
  return `ocbox ${command} failed with exit code ${status}${timeout}: ${cliErrorLine(
    result.stderr,
    result.stdout,
  )}`
}

/** Finds one result envelope by name and returns its data. */
export function parseResultEnvelope(stdout, expectedName) {
  for (const document of jsonDocuments(stdout).reverse()) {
    if (document?.kind === 'error') fail(errorText(document))
    if (document?.kind === 'result' && document.name === expectedName) return document.data
  }
  return fail(`ocbox did not print a ${expectedName} result`)
}

/** Decodes the JSONL stream from `ocbox exec --jsonl`. */
export function parseExecOutput(stdout) {
  const chunks = []
  let exitCode = null
  let error = null
  for (const document of jsonDocuments(stdout)) {
    if (document?.kind === 'error') {
      error = errorText(document)
      continue
    }
    if (
      document?.kind === 'event' &&
      document.event === 'stdout' &&
      document.encoding === 'base64' &&
      typeof document.data === 'string'
    ) {
      chunks.push(Buffer.from(document.data, 'base64').toString('utf8'))
    }
    if (
      document?.kind === 'event' &&
      document.event === 'completed' &&
      document.result !== undefined
    ) {
      exitCode = document.result.exitCode ?? null
    }
    if (document?.kind === 'result' && document.result !== undefined) {
      exitCode = document.result.exitCode ?? null
    }
    if (document?.kind === 'result' && document.outcome === 'infrastructure_error') {
      error = errorText({ data: document.error })
    }
  }
  return { output: chunks.join(''), exitCode, error }
}

/**
 * Picks the smallest size the list returned: CPU first, then memory, then disk.
 * A size that omits a measure sorts after one that reports it; equal measures
 * break on the id so the choice is deterministic.
 */
export function smallestSize(sizes) {
  if (!Array.isArray(sizes) || sizes.length === 0) fail('ocbox sizes returned no sizes')
  const measure = (size, key) => {
    const value = size?.[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
  }
  return [...sizes].sort((left, right) => {
    for (const key of ['cpuMillicores', 'memoryBytes', 'diskBytes']) {
      const leftValue = measure(left, key)
      const rightValue = measure(right, key)
      if (leftValue < rightValue) return -1
      if (leftValue > rightValue) return 1
    }
    return String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
  })[0]
}

function assertSafeArgument(value, label) {
  if (typeof value !== 'string' || !argumentPattern.test(value)) {
    fail(`${label} contains characters the smoke does not pass to a command`)
  }
}

function quoteWindowsArgument(value) {
  if (!/[\s"]/.test(value)) return value
  return `"${value.replaceAll('"', '\\"')}"`
}

function invocationFor(command, args) {
  if (process.platform !== 'win32') return { command, args }
  // cmd.exe /s strips the outer quote pair; keep the quoted command inside it
  // so a prefix path with spaces still runs the installed .cmd shim.
  const commandLine = `""${command}" ${args.map(quoteWindowsArgument).join(' ')}"`
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine],
    windowsVerbatimArguments: true,
  }
}

function runProcess(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const invocation = invocationFor(command, args)
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
    })
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, options.timeoutMilliseconds)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdoutBytes >= maximumOutputBytes) return
      stdout += chunk
      stdoutBytes += Buffer.byteLength(chunk)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= maximumOutputBytes) return
      stderr += chunk
      stderrBytes += Buffer.byteLength(chunk)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      rejectPromise(error)
    })
    child.once('close', (status) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolvePromise({ status, stdout, stderr, timedOut })
    })
  })
}

async function runCli({
  command,
  args,
  env,
  cwd,
  timeoutMilliseconds = defaultTimeoutMilliseconds,
}) {
  const name = args[0] ?? 'ocbox'
  let result
  try {
    result = await runProcess(command, args, { env, cwd, timeoutMilliseconds })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail(`ocbox ${name} could not run: ${message}`)
  }
  if (result.status !== 0) fail(formatCliFailure(name, result))
  return result
}

/**
 * The named smoke flow. `init` belongs to the live setup because a fresh
 * workspace needs a project before `start`; this function itself runs exactly
 * sizes, start, exec and destroy.
 */
export async function runSmoke(options) {
  const {
    command = 'ocbox',
    env = process.env,
    cwd,
    marker,
    timeoutMilliseconds = defaultTimeoutMilliseconds,
  } = options
  assertSafeArgument(marker, 'run marker')
  if (!runMarkerPattern.test(marker)) fail('run marker does not have the ocb-smoke- shape')

  const cli = (args, timeout) =>
    runCli({
      command,
      args,
      env,
      cwd,
      timeoutMilliseconds: timeout ?? timeoutMilliseconds,
    })

  const listed = await cli(['sizes', '--json'])
  const sizes = parseResultEnvelope(listed.stdout, 'sizes.listed').sizes
  const size = smallestSize(sizes)
  assertSafeArgument(size.id, 'size id')

  let startAttempted = false
  let sessionId
  let failure
  try {
    startAttempted = true
    const started = await cli(['start', '--size', size.id, '--json'], startTimeoutMilliseconds)
    const view = parseResultEnvelope(started.stdout, 'session.started')
    sessionId = view?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') {
      fail('ocbox start returned no session id')
    }

    const executed = await cli(['exec', '--jsonl', '--', 'echo', marker])
    const output = parseExecOutput(executed.stdout)
    if (output.error !== null) fail(`ocbox exec failed: ${output.error}`)
    if (!output.output.includes(marker)) fail('ocbox exec did not print the smoke marker')
    if (output.exitCode !== null && output.exitCode !== 0) {
      fail(`ocbox exec reported exit code ${output.exitCode}`)
    }
  } catch (error) {
    failure = error
  } finally {
    if (startAttempted) {
      try {
        const destroyed = await cli(['destroy', '--yes', '--json'], destroyTimeoutMilliseconds)
        const view = parseResultEnvelope(destroyed.stdout, 'session.destroyed')
        if (view?.session?.state !== 'destroyed') {
          fail('ocbox destroy did not report a destroyed session')
        }
      } catch (error) {
        if (failure === undefined) {
          failure = error
        } else {
          const message = error instanceof Error ? error.message : String(error)
          failure.message = `${failure.message}; destroy also failed: ${message}`
        }
      }
    }
  }

  if (failure !== undefined) throw failure
  return { marker, sizeId: size.id, sessionId }
}

function isolatedEnvironment(root, apiUrl) {
  const home = join(root, 'home')
  const state = join(root, 'state')
  const config = join(root, 'config')
  const cache = join(root, 'cache')
  const local = join(root, 'local')
  const roaming = join(root, 'roaming')
  const xdgState = join(root, 'xdg-state')
  const env = {
    ...process.env,
    ...(process.platform === 'win32'
      ? {
          HOME: home,
          USERPROFILE: home,
          APPDATA: roaming,
          LOCALAPPDATA: local,
        }
      : process.platform === 'darwin'
        ? { HOME: home }
        : {
            HOME: home,
            XDG_CONFIG_HOME: config,
            XDG_STATE_HOME: xdgState,
            XDG_CACHE_HOME: cache,
          }),
    OCBOX_API_URL: apiUrl,
    OCBOX_STATE_DIR: state,
    // A detached warm daemon would outlive this one-shot smoke.
    OCBOX_WARM: '0',
    NO_COLOR: '1',
  }
  // The token is handed to the credential store, never to a child process.
  delete env.OCB_STAGING_API_URL
  delete env.OCB_STAGING_CLI_TOKEN
  return {
    home,
    state,
    xdgState,
    directories: [home, state, config, cache, local, roaming, xdgState],
    env,
  }
}

async function installCredential({ apiUrl, token, env, home, state, packageRoot }) {
  const infrastructurePath = join(packageRoot, 'dist', 'infrastructure.js')
  let infrastructure
  try {
    infrastructure = await import(pathToFileURL(infrastructurePath).href)
  } catch {
    fail(
      `The built CLI infrastructure entrypoint is unavailable at ${infrastructurePath}; ` +
        'run `pnpm run build` first.',
    )
  }

  const platform =
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const paths = infrastructure.resolvePlatformPaths({
    platform,
    homeDirectory: home,
    environment: env,
    isWsl: false,
  })
  if (paths.credentialDirectory === null) {
    fail('Protected credential storage is unavailable for this staging smoke')
  }

  let endpoints
  try {
    endpoints = infrastructure.protocolEndpointsFromIssuer(apiUrl)
  } catch {
    fail('OCB_STAGING_API_URL is not a valid hosted API origin')
  }

  const key = {
    accountId: infrastructure.CLI_CREDENTIAL_ACCOUNT_ID,
    kind: 'hosted-oauth',
    provider: infrastructure.CLI_CREDENTIAL_PROVIDER,
  }
  const scopes = [...infrastructure.DEFAULT_SCOPES]
  const store = new infrastructure.ProtectedFileCredentialStore(paths.credentialDirectory)
  await store.set(key, {
    accessToken: token,
    // The supplied staging token is not a rotating OAuth family. A null expiry
    // keeps the CLI from trying to refresh it; a rejected token fails closed.
    expiresAt: null,
    scopes,
    tokenType: 'Bearer',
  })
  const metadata = new infrastructure.AuthMetadataStore(join(state, 'auth.json'))
  await metadata.save({
    schemaVersion: 1,
    audience: 'cli',
    clientId: endpoints.clientId,
    expiresAt: null,
    identity: key,
    issuer: endpoints.issuer,
    scopes,
    updatedAt: new Date().toISOString(),
  })
}

function requiredSecret(environment, name) {
  const value = environment[name]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function smokeRunId(environment) {
  const raw = environment.GITHUB_RUN_ID ?? randomUUID()
  const cleaned = raw.replace(/[^A-Za-z0-9-]/g, '').slice(0, 48)
  return cleaned === '' ? randomUUID() : cleaned
}

async function liveSmoke({ packageRoot }) {
  const apiUrl = requiredSecret(process.env, 'OCB_STAGING_API_URL')
  const token = requiredSecret(process.env, 'OCB_STAGING_CLI_TOKEN')
  const missing = []
  if (apiUrl === null) missing.push('OCB_STAGING_API_URL')
  if (token === null) missing.push('OCB_STAGING_CLI_TOKEN')
  if (missing.length > 0) {
    fail(`Missing required repository secret(s): ${missing.join(', ')}`)
  }

  const root = await mkdtemp(join(tmpdir(), 'ocbox-staging-smoke-'))
  try {
    const isolated = isolatedEnvironment(root, apiUrl)
    await Promise.all(
      isolated.directories.map((directory) => mkdir(directory, { recursive: true })),
    )
    await installCredential({
      apiUrl,
      token,
      env: isolated.env,
      home: isolated.home,
      state: isolated.state,
      packageRoot,
    })

    // A stable workspace name lets `init` reuse the same hosted project on the
    // next release instead of creating one per run.
    const cwd = join(root, 'ocb-staging-smoke')
    await mkdir(cwd, { recursive: true })
    await runCli({
      command: 'ocbox',
      args: ['init', '--json'],
      env: isolated.env,
      cwd,
    })

    const result = await runSmoke({
      command: 'ocbox',
      env: isolated.env,
      cwd,
      marker: `ocb-smoke-${smokeRunId(process.env)}`,
    })
    console.log('staging smoke: sizes, start, run, destroy passed')
    return result
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const fakeCliSource = `import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const command = argv[0] ?? ''
const jsonl = argv.includes('--jsonl')
const logPath = process.env.OCBOX_FAKE_LOG
if (logPath) appendFileSync(logPath, JSON.stringify({ command, args: argv.slice(1) }) + '\\n')

function envelope(name, data) {
  return { schemaVersion: 1, kind: 'result', name, timestamp: new Date().toISOString(), data }
}
// The CLI prints one pretty-printed envelope for --json and one compact
// envelope per line for --jsonl.
function write(value) {
  process.stdout.write((jsonl ? JSON.stringify(value) : JSON.stringify(value, null, 2)) + '\\n')
}
// A command failure is one error envelope on stderr.
function failCommand(code, message) {
  process.stderr.write(
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: 'error',
        name: 'error',
        timestamp: new Date().toISOString(),
        data: { code, message, requestId: 'req-smoke' },
      },
      null,
      2,
    ) + '\\n',
  )
  process.exit(1)
}
// A failed remote run ends with a completed event that carries its exit code.
function failRun(exitCode) {
  const timestamp = new Date().toISOString()
  write({
    schemaVersion: 1,
    kind: 'event',
    outcome: 'remote_result',
    event: 'completed',
    executionId: 'exec-smoke',
    sequence: 1,
    timestamp,
    result: { exitCode, signal: null, startedAt: timestamp, completedAt: timestamp },
  })
  process.exit(exitCode)
}
function option(name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

if (command === 'sizes') {
  write(
    envelope('sizes.listed', {
      sizes: [
        { id: 'size-large', cpuMillicores: 4000, memoryBytes: 8589934592, diskBytes: 107374182400 },
        { id: 'size-small', cpuMillicores: 1000, memoryBytes: 2147483648, diskBytes: 10737418240 },
        { id: 'size-medium', cpuMillicores: 2000, memoryBytes: 4294967296, diskBytes: 53687091200 },
      ],
    }),
  )
} else if (command === 'init') {
  write(
    envelope('project.initialized', {
      status: 'created',
      provider: 'ocbox',
      projectId: 'project-smoke',
      projectName: 'smoke',
      projectCreated: true,
    }),
  )
} else if (command === 'start') {
  if (option('--size') === undefined) failCommand('INVALID_SPEC', 'fake start needs a size')
  if (process.env.OCBOX_FAKE_FAIL_START === '1') {
    failCommand('CAPACITY_UNAVAILABLE', 'fake start failed')
  }
  write(
    envelope('session.started', {
      selected: true,
      session: { id: 'session-smoke', state: 'active', projectId: 'project-smoke' },
      sandbox: null,
      operation: null,
      capabilities: {},
    }),
  )
} else if (command === 'exec') {
  const separator = argv.indexOf('--')
  const marker =
    separator === -1 || argv[separator + 1] !== 'echo' ? undefined : argv[separator + 2]
  if (typeof marker !== 'string') failCommand('INVALID_SPEC', 'fake exec needs an echo marker')
  const timestamp = new Date().toISOString()
  write({
    schemaVersion: 1,
    kind: 'event',
    outcome: null,
    event: 'started',
    executionId: 'exec-smoke',
    sequence: 0,
    timestamp,
    type: 'started',
  })
  if (process.env.OCBOX_FAKE_FAIL_RUN === '1') failRun(7)
  write({
    schemaVersion: 1,
    kind: 'event',
    outcome: null,
    event: 'stdout',
    executionId: 'exec-smoke',
    sequence: 1,
    timestamp,
    encoding: 'base64',
    data: Buffer.from(marker + '\\n').toString('base64'),
  })
  write({
    schemaVersion: 1,
    kind: 'event',
    outcome: 'remote_result',
    event: 'completed',
    executionId: 'exec-smoke',
    sequence: 2,
    timestamp,
    result: { exitCode: 0, signal: null, startedAt: timestamp, completedAt: timestamp },
  })
} else if (command === 'destroy') {
  write(
    envelope('session.destroyed', {
      selected: true,
      session: { id: 'session-smoke', state: 'destroyed', projectId: 'project-smoke' },
      destroyOutcome: 'hosted',
    }),
  )
} else {
  process.stderr.write('Error: unknown command ' + command + '\\n')
  process.exit(2)
}
`

async function createFakeCli(root) {
  const directory = join(root, 'fake-cli')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'fake-ocbox.mjs'), fakeCliSource, 'utf8')
  if (process.platform === 'win32') {
    await writeFile(
      join(directory, 'ocbox.cmd'),
      '@echo off\r\nnode "%~dp0fake-ocbox.mjs" %*\r\n',
      'utf8',
    )
  } else {
    const launcher = join(directory, 'ocbox')
    await writeFile(
      launcher,
      '#!/bin/sh\nexec node "$(dirname "$0")/fake-ocbox.mjs" "$@"\n',
      'utf8',
    )
    await chmod(launcher, 0o755)
  }
  return { directory, log: join(root, 'fake-cli.log') }
}

async function readLog(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

/** Proves the flow and the finally-destroy with a fake CLI; needs no secrets. */
export async function selfTest() {
  const root = await mkdtemp(join(tmpdir(), 'ocbox-staging-smoke-self-'))
  try {
    const fake = await createFakeCli(root)
    const cwd = join(root, 'workspace')
    await mkdir(cwd, { recursive: true })
    const env = {
      ...process.env,
      PATH: `${fake.directory}${delimiter}${process.env.PATH ?? ''}`,
      OCBOX_FAKE_LOG: fake.log,
      NO_COLOR: '1',
    }
    delete env.OCB_STAGING_API_URL
    delete env.OCB_STAGING_CLI_TOKEN

    const passed = await runSmoke({
      command: 'ocbox',
      env,
      cwd,
      marker: 'ocb-smoke-selftest',
    })
    const passedLog = await readLog(fake.log)
    assert.deepEqual(
      passedLog.map((entry) => entry.command),
      ['sizes', 'start', 'exec', 'destroy'],
      'the smoke must run sizes, start, exec and destroy in order',
    )
    const start = passedLog.find((entry) => entry.command === 'start')
    assert.ok(
      start?.args.includes('size-small'),
      'the smoke must pass the smallest size the list returned',
    )
    assert.equal(passed.sessionId, 'session-smoke')

    await writeFile(fake.log, '', 'utf8')
    const failingEnv = { ...env, OCBOX_FAKE_FAIL_RUN: '1' }
    await assert.rejects(
      () =>
        runSmoke({
          command: 'ocbox',
          env: failingEnv,
          cwd,
          marker: 'ocb-smoke-selftest-fail',
        }),
      (error) => {
        assert.match(
          error.message,
          /ocbox exec failed with exit code 7: remote command exited with code 7/,
        )
        return true
      },
    )
    const failedLog = await readLog(fake.log)
    assert.deepEqual(
      failedLog.map((entry) => entry.command),
      ['sizes', 'start', 'exec', 'destroy'],
      'destroy must still run after a failed exec step',
    )
    assert.equal(failedLog.at(-1)?.command, 'destroy')

    await writeFile(fake.log, '', 'utf8')
    const startFailingEnv = { ...env, OCBOX_FAKE_FAIL_START: '1' }
    await assert.rejects(
      () =>
        runSmoke({
          command: 'ocbox',
          env: startFailingEnv,
          cwd,
          marker: 'ocb-smoke-selftest-start-fail',
        }),
      (error) => {
        assert.match(
          error.message,
          /ocbox start failed with exit code 1: CAPACITY_UNAVAILABLE: fake start failed/,
        )
        return true
      },
    )
    const startFailedLog = await readLog(fake.log)
    assert.deepEqual(
      startFailedLog.map((entry) => entry.command),
      ['sizes', 'start', 'destroy'],
      'destroy must still run after a failed start step',
    )
    console.log('staging smoke self-test: passed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function parseArguments(argv) {
  let selfTestMode = false
  let packageRoot = repoRoot
  for (const argument of argv) {
    if (argument === '--self-test') {
      selfTestMode = true
    } else if (argument.startsWith('--package-root=')) {
      packageRoot = resolve(argument.slice('--package-root='.length))
    } else {
      fail(
        `unknown argument ${JSON.stringify(argument)}. ` +
          'Usage: node scripts/staging-smoke.mjs [--self-test] [--package-root=<dir>]',
      )
    }
  }
  return { selfTestMode, packageRoot }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    const options = parseArguments(process.argv.slice(2))
    if (options.selfTestMode) {
      await selfTest()
    } else {
      await liveSmoke({ packageRoot: options.packageRoot })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`staging smoke failed: ${message}`)
    process.exitCode = 1
  }
}

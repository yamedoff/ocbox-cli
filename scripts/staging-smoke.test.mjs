import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  cliErrorLine,
  formatCliFailure,
  parseExecOutput,
  parseResultEnvelope,
  selfTest,
  smallestSize,
  windowsCommandLine,
} from './staging-smoke.mjs'

const timestamp = '2026-01-01T00:00:00.000Z'

// The CLI's own stderr output for `ocbox project list --json` without a login:
// one pretty-printed envelope across many lines (src/output/writer.ts).
const capturedAuthErrorEnvelope = `{
  "data": {
    "code": "AUTH_REQUIRED",
    "message": "Authentication is required; run \`ocbox auth login\`",
    "requestId": "141fbdf4-22c4-4248-b60d-5b57bdb0b093",
    "retryable": false
  },
  "kind": "error",
  "name": "error",
  "schemaVersion": 1,
  "timestamp": "2026-11-23T15:49:40.887Z"
}
`

function errorEnvelope(code, message) {
  return {
    schemaVersion: 1,
    kind: 'error',
    name: 'error',
    timestamp,
    data: { code, message, requestId: 'req-smoke' },
  }
}

function resultEnvelope(name, data) {
  return { schemaVersion: 1, kind: 'result', name, timestamp, data }
}

function jsonLines(values) {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`
}

test('smallestSize picks the lowest cpu, then memory and disk, and sorts missing measures last', () => {
  const sizes = [
    { id: 'large', cpuMillicores: 4000, memoryBytes: 8192, diskBytes: 102_400 },
    { id: 'medium', cpuMillicores: 2000, memoryBytes: 4096, diskBytes: 51_200 },
    { id: 'small', cpuMillicores: 1000, memoryBytes: 2048, diskBytes: 10_240 },
  ]
  assert.equal(smallestSize(sizes).id, 'small')

  const cpuTie = [
    { id: 'more-memory', cpuMillicores: 1000, memoryBytes: 4096, diskBytes: 10 },
    { id: 'less-memory', cpuMillicores: 1000, memoryBytes: 2048, diskBytes: 20 },
  ]
  assert.equal(smallestSize(cpuTie).id, 'less-memory')

  const memoryTie = [
    { id: 'bigger-disk', cpuMillicores: 1000, memoryBytes: 2048, diskBytes: 30 },
    { id: 'smaller-disk', cpuMillicores: 1000, memoryBytes: 2048, diskBytes: 20 },
  ]
  assert.equal(smallestSize(memoryTie).id, 'smaller-disk')

  const missingCpu = [
    { id: 'no-cpu', memoryBytes: 1, diskBytes: 1 },
    { id: 'has-cpu', cpuMillicores: 5000, memoryBytes: 1, diskBytes: 1 },
  ]
  assert.equal(smallestSize(missingCpu).id, 'has-cpu')

  const missingMemory = [
    { id: 'no-memory', cpuMillicores: 1000, diskBytes: 1 },
    { id: 'has-memory', cpuMillicores: 1000, memoryBytes: 4096, diskBytes: 1 },
  ]
  assert.equal(smallestSize(missingMemory).id, 'has-memory')

  const missingDisk = [
    { id: 'no-disk', cpuMillicores: 1000, memoryBytes: 2048 },
    { id: 'has-disk', cpuMillicores: 1000, memoryBytes: 2048, diskBytes: 1024 },
  ]
  assert.equal(smallestSize(missingDisk).id, 'has-disk')
})

test('smallestSize throws when the size list is empty', () => {
  assert.throws(() => smallestSize([]), /ocbox sizes returned no sizes/)
  assert.throws(() => smallestSize(), /ocbox sizes returned no sizes/)
})

test('formatCliFailure names the command, exit code and only the CLI error line', () => {
  const message = formatCliFailure('start', {
    status: 7,
    stderr: jsonLines([errorEnvelope('INVALID_SPEC', 'fake start needs a size')]),
    stdout: jsonLines([resultEnvelope('session.started', { session: { id: 'session-smoke' } })]),
    timedOut: false,
  })
  assert.equal(
    message,
    'ocbox start failed with exit code 7: INVALID_SPEC: fake start needs a size',
  )
  assert.ok(!message.includes('req-smoke'))
  assert.ok(!message.includes('schemaVersion'))
  assert.ok(!message.includes('session-smoke'))
  assert.ok(!message.includes('{'))

  assert.equal(
    formatCliFailure('exec', { status: null, stderr: '', stdout: '', timedOut: true }),
    'ocbox exec failed with exit code none (timed out): the CLI printed no error line',
  )
})

test('windowsCommandLine keeps a bare command name unquoted so a .cmd shim finds itself', () => {
  assert.equal(windowsCommandLine('ocbox', ['sizes', '--json']), '"ocbox sizes --json"')
  assert.equal(
    windowsCommandLine('ocbox', ['exec', '--jsonl', '--', 'echo', 'ocb-smoke-selftest']),
    '"ocbox exec --jsonl -- echo ocb-smoke-selftest"',
  )
  assert.equal(
    windowsCommandLine('C:\\Users\\smoke\\ocbox.cmd', ['destroy', '--yes', '--json']),
    '"C:\\Users\\smoke\\ocbox.cmd destroy --yes --json"',
  )
  assert.equal(
    windowsCommandLine('C:\\Program Files\\ocbox\\ocbox.cmd', ['sizes']),
    '""C:\\Program Files\\ocbox\\ocbox.cmd" sizes"',
  )
})

test('cliErrorLine falls back to the last human stderr line and prefers JSON errors', () => {
  assert.equal(cliErrorLine('warning: retrying\n\nlast human line\n\n', ''), 'last human line')

  const stderr = `human context\n${jsonLines([errorEnvelope('AUTH_FAILED', 'token rejected')])}`
  assert.equal(cliErrorLine(stderr, ''), 'AUTH_FAILED: token rejected')

  const stdout = jsonLines([errorEnvelope('QUOTA_EXCEEDED', 'no capacity')])
  assert.equal(cliErrorLine('human context\n', stdout), 'QUOTA_EXCEEDED: no capacity')

  const completed = jsonLines([
    { schemaVersion: 1, kind: 'event', event: 'completed', result: { exitCode: 9 } },
  ])
  assert.equal(cliErrorLine('', completed), 'remote command exited with code 9')
})

test('parseResultEnvelope returns the named result data and throws on errors or missing results', () => {
  const stdout = jsonLines([
    { schemaVersion: 1, kind: 'event', event: 'progress', timestamp },
    resultEnvelope('sizes.listed', { sizes: [{ id: 'size-small' }] }),
    resultEnvelope('session.started', { session: { id: 'session-smoke' } }),
  ])
  assert.deepEqual(parseResultEnvelope(stdout, 'sizes.listed'), {
    sizes: [{ id: 'size-small' }],
  })
  assert.deepEqual(parseResultEnvelope(stdout, 'session.started'), {
    session: { id: 'session-smoke' },
  })

  const errorStdout = jsonLines([errorEnvelope('NOT_FOUND', 'no such session')])
  assert.throws(
    () => parseResultEnvelope(errorStdout, 'session.started'),
    /NOT_FOUND: no such session/,
  )
  assert.throws(
    () => parseResultEnvelope(stdout, 'session.destroyed'),
    /ocbox did not print a session\.destroyed result/,
  )
})

test('parseResultEnvelope reads the pretty-printed envelope the CLI prints for --json', () => {
  const stdout = `${JSON.stringify(
    {
      schemaVersion: 1,
      kind: 'result',
      name: 'sizes.listed',
      timestamp,
      data: { sizes: [{ id: 'size-small', cpuMillicores: 1000 }] },
    },
    null,
    2,
  )}\n`
  assert.deepEqual(parseResultEnvelope(stdout, 'sizes.listed'), {
    sizes: [{ id: 'size-small', cpuMillicores: 1000 }],
  })
})

test('parseResultEnvelope reads the compact JSONL envelope the CLI prints for --jsonl', () => {
  const stdout = jsonLines([
    resultEnvelope('sizes.listed', { sizes: [{ id: 'size-small', cpuMillicores: 1000 }] }),
  ])
  assert.deepEqual(parseResultEnvelope(stdout, 'sizes.listed'), {
    sizes: [{ id: 'size-small', cpuMillicores: 1000 }],
  })
})

test('cliErrorLine reads the pretty-printed error envelope the CLI writes to stderr', () => {
  const line = cliErrorLine(capturedAuthErrorEnvelope, '')
  assert.equal(line, 'AUTH_REQUIRED: Authentication is required; run `ocbox auth login`')
  assert.notEqual(line, '}')
})

test('formatCliFailure reports the pretty-printed stderr envelope without JSON braces', () => {
  const message = formatCliFailure('start', {
    status: 1,
    stderr: capturedAuthErrorEnvelope,
    stdout: '',
    timedOut: false,
  })
  assert.equal(
    message,
    'ocbox start failed with exit code 1: AUTH_REQUIRED: Authentication is required; run `ocbox auth login`',
  )
  assert.ok(!message.includes('{'))
  assert.ok(!message.includes('}'))
})

test('parseExecOutput decodes base64 stdout events and reads the final exit code', () => {
  const stdout = jsonLines([
    {
      schemaVersion: 1,
      kind: 'event',
      event: 'stdout',
      encoding: 'base64',
      data: Buffer.from('first line\n').toString('base64'),
    },
    {
      schemaVersion: 1,
      kind: 'event',
      event: 'stdout',
      encoding: 'base64',
      data: Buffer.from('second line\n').toString('base64'),
    },
    { schemaVersion: 1, kind: 'event', event: 'completed', result: { exitCode: 0 } },
    { schemaVersion: 1, kind: 'result', result: { exitCode: 3 } },
  ])
  assert.deepEqual(parseExecOutput(stdout), {
    output: 'first line\nsecond line\n',
    exitCode: 3,
    error: null,
  })
})

test('parseExecOutput reads the compact JSONL execution stream the CLI prints for exec --jsonl', () => {
  const stdout = jsonLines([
    {
      schemaVersion: 1,
      kind: 'event',
      outcome: null,
      event: 'started',
      type: 'started',
      executionId: 'exec-smoke',
      sequence: 0,
      timestamp,
    },
    {
      schemaVersion: 1,
      kind: 'event',
      outcome: null,
      event: 'stdout',
      executionId: 'exec-smoke',
      sequence: 1,
      timestamp,
      encoding: 'base64',
      data: Buffer.from('ocb-smoke-selftest\n').toString('base64'),
    },
    {
      schemaVersion: 1,
      kind: 'event',
      outcome: 'remote_result',
      event: 'completed',
      executionId: 'exec-smoke',
      sequence: 2,
      timestamp,
      result: {
        exitCode: 0,
        signal: null,
        startedAt: timestamp,
        completedAt: timestamp,
      },
    },
  ])
  assert.deepEqual(parseExecOutput(stdout), {
    output: 'ocb-smoke-selftest\n',
    exitCode: 0,
    error: null,
  })
})

test('cliErrorLine reports the exit code of a non-zero completed event in the exec stream', () => {
  const stdout = jsonLines([
    {
      schemaVersion: 1,
      kind: 'event',
      outcome: 'remote_result',
      event: 'completed',
      executionId: 'exec-smoke',
      sequence: 1,
      timestamp,
      result: {
        exitCode: 7,
        signal: null,
        startedAt: timestamp,
        completedAt: timestamp,
      },
    },
  ])
  assert.equal(cliErrorLine('', stdout), 'remote command exited with code 7')
})

test('parseExecOutput reports an infrastructure error message', () => {
  const stdout = jsonLines([
    {
      schemaVersion: 1,
      kind: 'event',
      event: 'stdout',
      encoding: 'base64',
      data: Buffer.from('partial output').toString('base64'),
    },
    {
      schemaVersion: 1,
      kind: 'result',
      outcome: 'infrastructure_error',
      error: { code: 'SANDBOX_UNAVAILABLE', message: 'no sandbox' },
    },
  ])
  assert.deepEqual(parseExecOutput(stdout), {
    output: 'partial output',
    exitCode: null,
    error: 'SANDBOX_UNAVAILABLE: no sandbox',
  })
})

test('selfTest runs the fake CLI flow and resolves', async () => {
  const resolution = await selfTest().then(() => 'resolved')
  assert.equal(resolution, 'resolved')
})

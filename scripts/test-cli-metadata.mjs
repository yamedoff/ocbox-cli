import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

// Pass an extracted npm tarball's package directory to exercise the same
// authenticated commands from the packed artifact instead of the checkout.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = process.argv[2] === undefined ? repository : resolve(process.argv[2])
const infra = await import(pathToFileURL(join(packageRoot, 'dist', 'infrastructure.js')).href)
const temporary = await mkdtemp(join(tmpdir(), 'ocbox-metadata-'))
const platformRoot = join(temporary, 'platform')
const stateRoot = join(temporary, 'state')
const credential = {
  accessToken: 'fixture-access-'.padEnd(48, 'a'),
  refreshToken: 'fixture-refresh-'.padEnd(48, 'r'),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  scopes: ['source:read', 'product:read', 'product:edit', 'product:run'],
  tokenType: 'Bearer',
}
const launchNames = new Set([
  'path',
  'pathext',
  'systemroot',
  'systemdrive',
  'windir',
  'comspec',
  'temp',
  'tmp',
])
const baseEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => launchNames.has(name.toLowerCase())),
)
const isolated =
  process.platform === 'win32'
    ? { APPDATA: platformRoot, LOCALAPPDATA: platformRoot, USERPROFILE: platformRoot }
    : process.platform === 'darwin'
      ? { HOME: platformRoot }
      : { HOME: platformRoot, XDG_CONFIG_HOME: platformRoot, XDG_STATE_HOME: platformRoot }
const environment = { ...baseEnvironment, ...isolated }
const calls = []
const project = {
  id: randomUUID(),
  name: 'Onboarding',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}
const resourceEnvironment = { ...project, id: randomUUID(), projectId: project.id, selected: false }
let responseMode = 'normal'
const server = createServer(async (request, response) => {
  // Never emit bearer values, even on fixture assertion failures.
  const authorized = request.headers.authorization === `Bearer ${credential.accessToken}`
  if (!authorized) {
    response.writeHead(401, { 'content-type': 'application/json' }).end('{}')
    return
  }
  let text = ''
  for await (const chunk of request) text += chunk
  const url = new URL(request.url, 'http://127.0.0.1')
  const body = text.length === 0 ? null : JSON.parse(text)
  calls.push({
    method: request.method,
    path: url.pathname,
    query: url.searchParams,
    body,
    key: request.headers['idempotency-key'],
  })
  let result
  if (responseMode === 'malformed') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('fixture-private-field')
    return
  }
  if (responseMode === 'forbidden') {
    response.writeHead(403, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        error: { code: 'AUTH_FORBIDDEN', message: 'Forbidden' },
        requestId: randomUUID(),
      }),
    )
    return
  }
  if (url.pathname === '/v1/projects' && request.method === 'GET') {
    result = { data: [project], nextCursor: 'next+/=' }
  } else if (url.pathname.endsWith('/environments') && request.method === 'GET') {
    result = { data: [resourceEnvironment], nextCursor: null }
  } else if (url.pathname.includes('/environments')) {
    result = { ...resourceEnvironment, ...body }
  } else result = { ...project, ...body }
  if (responseMode === 'private') result.privateToken = 'fixture-private-field'
  response
    .writeHead(request.method === 'POST' ? 201 : 200, {
      'content-type': 'application/json',
      'x-request-id': randomUUID(),
      'idempotency-replayed': 'true',
    })
    .end(JSON.stringify(result))
})

async function run(args, extraEnvironment = {}, fails = false) {
  let output
  try {
    output = await promisify(execFile)(
      process.execPath,
      [join(packageRoot, 'dist', 'index.js'), ...args, '--json', '--state-dir', stateRoot],
      {
        cwd: temporary,
        env: { ...environment, ...extraEnvironment },
        timeout: 30_000,
        windowsHide: true,
      },
    )
    assert(!fails, 'command must fail closed')
  } catch (error) {
    if (!fails || typeof error.stdout !== 'string') throw error
    output = error
    assert.equal(error.code, 1)
  }
  assert(
    !output.stdout.includes(credential.accessToken) &&
      !output.stderr.includes(credential.accessToken),
    'output must redact credentials',
  )
  return JSON.parse(output.stdout.trim() || output.stderr.trim())
}

try {
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const issuer = `http://127.0.0.1:${server.address().port}`
  environment.OCBOX_API_URL = issuer
  const key = {
    accountId: infra.CLI_CREDENTIAL_ACCOUNT_ID,
    kind: 'hosted-oauth',
    provider: infra.CLI_CREDENTIAL_PROVIDER,
  }
  const store = new infra.ProtectedFileCredentialStore(
    infra.resolveCurrentPlatformPaths(environment).credentialDirectory,
  )
  const metadata = new infra.AuthMetadataStore(join(stateRoot, 'auth.json'))
  await store.set(key, credential)
  const binding = {
    schemaVersion: 1,
    issuer,
    clientId: infra.protocolEndpointsFromIssuer(issuer).clientId,
    audience: 'cli',
    scopes: credential.scopes,
    expiresAt: credential.expiresAt,
    identity: key,
    updatedAt: new Date().toISOString(),
  }
  await metadata.save(binding)
  const retryKey = randomUUID()
  const commands = [
    ['project', 'list', '--limit', '2', '--cursor', 'start+/='],
    ['project', 'create', '--name', 'Created', '--idempotency-key', retryKey],
    ['project', 'get', '--project-id', project.id],
    [
      'project',
      'update',
      '--project-id',
      project.id,
      '--name',
      'Renamed',
      '--idempotency-key',
      retryKey,
    ],
    ['environment', 'list', '--project-id', project.id],
    [
      'environment',
      'create',
      '--project-id',
      project.id,
      '--name',
      'Development',
      '--idempotency-key',
      retryKey,
    ],
    ['environment', 'get', '--environment-id', resourceEnvironment.id],
    [
      'environment',
      'update',
      '--environment-id',
      resourceEnvironment.id,
      '--selected',
      'false',
      '--idempotency-key',
      retryKey,
    ],
  ]
  for (const command of commands) {
    const output = await run(command)
    assert.equal(output.kind, 'result', 'stable result envelope is required')
    assert.equal(output.name, `${command[0]}.${command[1]}`)
    assert.equal(output.data.meta.replay, true)
    assert.equal(output.data.meta.status, command[1] === 'create' ? 201 : 200)
    const resource = output.data.resource
    if (command[1] === 'list') {
      assert.equal(resource.data.length, 1)
      assert.equal(
        resource.data[0].id,
        command[0] === 'project' ? project.id : resourceEnvironment.id,
      )
    } else assert.equal(resource.id, command[0] === 'project' ? project.id : resourceEnvironment.id)
    if (command[0] === 'environment' && command[1] === 'update')
      assert.equal(resource.selected, false)
  }
  assert.equal(calls.length, 8, 'every registered command must issue exactly one HTTP request')
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/v1/projects',
      '/v1/projects',
      `/v1/projects/${project.id}`,
      `/v1/projects/${project.id}`,
      `/v1/projects/${project.id}/environments`,
      `/v1/projects/${project.id}/environments`,
      `/v1/environments/${resourceEnvironment.id}`,
      `/v1/environments/${resourceEnvironment.id}`,
    ],
  )
  assert.deepEqual(
    calls.map((call) => call.body),
    [
      null,
      { name: 'Created' },
      null,
      { name: 'Renamed' },
      null,
      { name: 'Development' },
      null,
      { selected: false },
    ],
  )
  assert.deepEqual(
    calls.map((call) => call.method),
    ['GET', 'POST', 'GET', 'PATCH', 'GET', 'POST', 'GET', 'PATCH'],
  )
  assert.equal(calls[0].query.get('limit'), '2')
  assert.equal(calls[0].query.get('cursor'), 'start+/=')
  assert.deepEqual(calls[7].body, { selected: false })
  for (const index of [1, 3, 5, 7]) assert.equal(calls[index].key, retryKey)
  responseMode = 'forbidden'
  assert(JSON.stringify(await run(['project', 'list'], {}, true)).includes('AUTH_FORBIDDEN'))
  responseMode = 'private'
  const rejected = JSON.stringify(
    await run(['project', 'get', '--project-id', project.id], {}, true),
  )
  assert(rejected.includes('INTERNAL') && !rejected.includes('fixture-private-field'))
  responseMode = 'malformed'
  const malformed = JSON.stringify(await run(['project', 'list'], {}, true))
  assert(malformed.includes('INTERNAL') && !malformed.includes('fixture-pr'))
  responseMode = 'normal'
  const callCount = calls.length
  await metadata.save({ ...binding, issuer: 'https://foreign.test' })
  await run(['project', 'list'], {}, true)
  assert.equal(calls.length, callCount, 'foreign issuer credentials must never reach HTTP')
  await metadata.clear()
  await store.delete(key)
  await run(
    ['project', 'list'],
    { OCBOX_API_TOKEN: credential.accessToken, OCBOX_TOKEN: credential.accessToken },
    true,
  )
  assert.equal(calls.length, callCount, 'static environment tokens must never reach HTTP')
  console.log(
    'CLI metadata: eight authenticated HTTP commands, pagination, replay keys, protected issuer binding, and fail-closed output passed',
  )
} finally {
  await new Promise((resolveClose) => server.close(resolveClose))
  await rm(temporary, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
    (await invoke(projectDirectory, ['init', '--provider', 'fake', ...runtimeFlags, '--json']))
      .stdout,
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

  await hostedLifecycle()
  process.stdout.write('CLI lifecycle E2E passed\n')
} finally {
  await rm(projectDirectory, { recursive: true, force: true })
}

/** Each invocation below launches a fresh built CLI against a loopback-only API. */
async function hostedLifecycle() {
  const infrastructure = await import(
    pathToFileURL(join(repositoryRoot, 'dist', 'infrastructure.js')).href
  )
  const root = await mkdtemp(join(tmpdir(), 'ocbox-hosted-lifecycle-'))
  const platformRoot = join(root, 'platform')
  const state = join(root, 'state')
  const config = join(root, 'opencloudbox.toml')
  const flags = ['--config', config, '--state-dir', state]
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
  const environment = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => launchNames.has(name.toLowerCase())),
    ),
    HOME: platformRoot,
    XDG_CONFIG_HOME: platformRoot,
    XDG_STATE_HOME: platformRoot,
    APPDATA: platformRoot,
    LOCALAPPDATA: platformRoot,
    USERPROFILE: platformRoot,
    NO_COLOR: '1',
    OCBOX_PROJECT_ID: 'hosted_project',
  }
  const now = new Date().toISOString()
  const requestId = '11111111-1111-4111-8111-111111111111'
  const calls = []
  const sessions = new Map()
  const operations = new Map()
  let creates = 0
  let missing = false
  let sessionId
  let refreshes = 0
  let longExecution = false
  let executionCancelled = false
  let executionSessionId
  let executionSandboxId
  const manifests = new Map()
  const sourceKeys = new Map()
  const workspace = join(root, 'workspace', 'hosted_project')
  let sourceCreates = 0
  let chunkUploads = 0
  let delivered = 0
  let sourceClock = Date.now()
  let executionStdout = ''
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const publicManifest = ({ chunks, ...manifest }) => manifest
  const handler = async (request, response) => {
    const bodyChunks = []
    for await (const chunk of request) bodyChunks.push(chunk)
    const rawBody = Buffer.concat(bodyChunks).toString('utf8')
    const body = rawBody ? JSON.parse(rawBody) : undefined
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    calls.push([request.method, path])
    const send = (body, status = 200) =>
      response
        .writeHead(status, {
          'content-type': 'application/json',
          'x-request-id': requestId,
        })
        .end(JSON.stringify(body))
    const absent = () => send({ error: { code: 'NOT_FOUND', message: 'missing' }, requestId }, 404)
    if (path === '/v1/auth/cli/token') {
      refreshes += 1
      return send({
        accessToken: 'mock_rotated_access'.padEnd(48, 'a'),
        refreshToken: 'mock_rotated_refresh'.padEnd(48, 'r'),
        tokenType: 'Bearer',
        expiresIn: 900,
        scope: infrastructure.DEFAULT_SCOPES.join(' '),
      })
    }
    if (path === '/v1/projects/hosted_project' && request.method === 'GET') {
      return send({ id: 'hosted_project', name: 'mock', createdAt: now, updatedAt: now })
    }
    if (path === '/v1/projects/hosted_project/sessions' && request.method === 'POST') {
      creates += 1
      sessionId = `hosted_session_${creates}`
      sessions.set(sessionId, {
        id: sessionId,
        projectId: 'hosted_project',
        createdAt: now,
        updatedAt: now,
        requestedSpec: {},
        effectiveSpec: {},
        normalizedState: 'running',
        rawState: 'running',
        primarySandboxId: `hosted_sandbox_${creates}`,
        sandboxes: [
          {
            ordinal: 0,
            role: 'primary',
            active: true,
            state: 'running',
            sandboxId: `hosted_sandbox_${creates}`,
            boundAt: now,
            releasedAt: null,
          },
        ],
      })
      return operation('create', sessionId)
    }
    if (path.startsWith('/v1/operations/')) return send(operations.get(path.split('/').at(-1)))
    const sourceSession = /^\/v1\/sessions\/([^/]+)\/source\/manifests$/.exec(path)
    if (sourceSession) {
      const id = sourceSession[1]
      assert(sessions.has(id))
      if (request.method === 'GET')
        return send({
          data: [...manifests.values()].filter((item) => item.sessionId === id).map(publicManifest),
          nextCursor: null,
        })
      assert.equal(request.method, 'POST')
      const key = request.headers['idempotency-key']
      assert.equal(typeof key, 'string')
      if (sourceKeys.has(key)) {
        const previous = sourceKeys.get(key)
        assert.equal(previous.rawBody, rawBody, 'replay keys must retain their payload')
        return send(previous.body, 201)
      }
      sourceCreates += 1
      const manifest = {
        ...body,
        id: `source_${sourceCreates}`,
        sessionId: id,
        createdAt: new Date(++sourceClock).toISOString(),
        updatedAt: new Date(sourceClock).toISOString(),
        verified: false,
        uploadedChunks: 0,
        chunks: new Map(),
      }
      manifests.set(manifest.id, manifest)
      const created = publicManifest(manifest)
      sourceKeys.set(key, { rawBody, body: created })
      return send(created, 201)
    }
    const sourceRoute = /^\/v1\/source\/manifests\/([^/]+)\/(?:chunks\/(\d+)|(checksum))$/.exec(
      path,
    )
    if (sourceRoute) {
      const [, id, index, checksum] = sourceRoute
      const manifest = manifests.get(id)
      assert(manifest)
      assert.equal(typeof request.headers['idempotency-key'], 'string')
      if (!checksum) {
        assert.equal(request.method, 'PUT')
        chunkUploads += 1
        const bytes = Buffer.from(body.data, 'base64')
        assert.equal(bytes.toString('base64'), body.data)
        assert(bytes.length <= 1024 * 1024)
        assert.equal(sha256(bytes), body.checksum)
        if (manifest.chunks.has(Number(index)))
          assert.deepEqual(manifest.chunks.get(Number(index)), bytes)
        manifest.chunks.set(Number(index), bytes)
        manifest.uploadedChunks = manifest.chunks.size
        return send({
          manifestId: id,
          chunkIndex: Number(index),
          chunkChecksum: body.checksum,
          receivedBytes: bytes.length,
          uploadedChunks: manifest.uploadedChunks,
        })
      }
      assert.equal(request.method, 'POST')
      assert.equal(manifest.chunks.size, manifest.chunkCount)
      const archive = Buffer.concat(
        Array.from({ length: manifest.chunkCount }, (_, i) => manifest.chunks.get(i)),
      )
      assert.equal(archive.length, manifest.totalBytes)
      assert(archive.length <= 1024 * 1024)
      assert.equal(sha256(archive), manifest.checksum)
      if (!manifest.verified) {
        // Model managed delivery: decode the frozen OCBOXA1 archive into the
        // project workspace (the same entries the server converts to tar).
        assert.equal(archive.subarray(0, 8).toString(), 'OCBOXA1\n')
        const entries = []
        let offset = 8
        let fileBytes = 0
        let fileCount = 0
        await mkdir(workspace, { recursive: true })
        for (;;) {
          const length = archive.readUInt32BE(offset)
          offset += 4
          const header = JSON.parse(archive.subarray(offset, offset + length).toString('utf8'))
          offset += length
          if (header.type === 'end') {
            assert.equal(
              header.snapshotSha256,
              sha256(Buffer.from(entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''))),
            )
            assert.equal(offset, archive.length)
            break
          }
          const entry = header.entry
          assert(!entry.path.startsWith('/') && !entry.path.split('/').includes('..'))
          assert.equal(entry.linkTarget, null)
          if (entries.length)
            assert(Buffer.compare(Buffer.from(entries.at(-1).path), Buffer.from(entry.path)) < 0)
          entries.push(entry)
          const destination = join(workspace, ...entry.path.split('/'))
          if (entry.type === 'directory') await mkdir(destination, { recursive: true })
          else {
            fileCount += 1
            fileBytes += entry.size
            assert(entry.size <= 65536 && fileBytes <= 524288 && fileCount <= 100)
            const bytes = archive.subarray(offset, offset + entry.size)
            offset += entry.size
            assert.equal(sha256(bytes), entry.sha256)
            await mkdir(dirname(destination), { recursive: true })
            await writeFile(destination, bytes)
          }
        }
        delivered += 1
        manifest.verified = true
        manifest.updatedAt = new Date(++sourceClock).toISOString()
      }
      return send({
        manifestId: id,
        checksum: manifest.checksum,
        chunkCount: manifest.chunkCount,
        verified: true,
      })
    }
    const matched = /^\/v1\/sessions\/([^/]+)(?:\/(.*))?$/.exec(path)
    if (matched) {
      const [, id, action] = matched
      const session = sessions.get(id)
      if (!session || missing) return absent()
      if (!action) return send(session)
      if (action === 'executions') {
        executionSessionId = id
        executionSandboxId = session.primarySandboxId
        executionCancelled = false
        // Managed commands resolve paths relative to /workspace/<projectId>.
        executionStdout =
          body.command === "'cat' 'a.txt'" ? await readFile(join(workspace, 'a.txt'), 'utf8') : ''
        return send(
          {
            id: 'hosted_execution',
            createdAt: now,
            sessionId: id,
            sandboxId: session.primarySandboxId,
          },
          202,
        )
      }
      if (action === 'stop') {
        session.sandboxes[0].state = 'stopped'
        session.normalizedState = 'stopped'
      }
      if (action === 'start') {
        session.sandboxes[0].state = 'running'
        session.normalizedState = 'running'
      }
      if (action === 'destroy') sessions.delete(id)
      return operation(action, id)
    }
    if (path === '/v1/executions/hosted_execution/cancel') {
      executionCancelled = true
      return send({ id: 'cancel_operation' }, 202)
    }
    if (path === '/v1/executions/hosted_execution')
      return send({
        id: 'hosted_execution',
        createdAt: now,
        updatedAt: now,
        sessionId: executionSessionId,
        sandboxId: executionSandboxId,
        state: executionCancelled ? 'cancelled' : longExecution ? 'running' : 'completed',
        command: longExecution ? 'sleep 600' : 'echo mock',
        exitCode: null,
        failureKind: null,
        failure: null,
        truncated: false,
        outputBytes: 0,
        outputLimitBytes: 1024,
      })
    if (path === '/v1/executions/hosted_execution/events' && longExecution && !executionCancelled)
      return send({ data: [], nextCursor: null })
    if (path === '/v1/executions/hosted_execution/events')
      return send({
        data: [
          ...(executionStdout
            ? [{ sequence: 0, at: now, kind: 'stdout', stream: 'stdout', message: executionStdout }]
            : []),
          {
            sequence: executionStdout ? 1 : 0,
            at: now,
            kind: executionCancelled ? 'cancelled' : 'completed',
            stream: null,
            message: '',
          },
        ],
        nextCursor: null,
      })
    if (path === '/v1/executions/hosted_execution/result' && executionCancelled)
      return send({ kind: 'cancelled' })
    if (path === '/v1/executions/hosted_execution/result')
      return send({
        kind: 'command',
        exitCode: 0,
        stdout: executionStdout,
        stderr: '',
        truncated: false,
        outputBytes: 0,
        outputLimitBytes: 1024,
      })
    return absent()

    function operation(action, id) {
      const op = {
        id: `operation_${operations.size}`,
        kind: `session_${action}`,
        createdAt: now,
        updatedAt: now,
        projectId: 'hosted_project',
        sessionId: id,
        state: 'succeeded',
        progress: 100,
        requestId,
        error: null,
        resource: null,
      }
      operations.set(op.id, op)
      return send(op, 202)
    }
  }
  const server = createServer(handler)
  const otherServer = createServer(handler)
  const listen = (instance) => new Promise((done) => instance.listen(0, '127.0.0.1', done))
  await listen(server)
  await listen(otherServer)
  const origin = `http://127.0.0.1:${server.address().port}`
  const otherOrigin = `http://127.0.0.1:${otherServer.address().port}`
  environment.OCBOX_API_URL = origin
  const credentials = new infrastructure.ProtectedFileCredentialStore(
    infrastructure.resolveCurrentPlatformPaths(environment).credentialDirectory,
  )
  const key = { kind: 'hosted-oauth', provider: 'ocbox', accountId: 'default' }
  const metadataStore = new infrastructure.AuthMetadataStore(join(state, 'auth.json'))
  const credential = {
    tokenType: 'Bearer',
    accessToken: 'mock_hosted_access',
    refreshToken: 'mock_hosted_refresh',
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    scopes: infrastructure.DEFAULT_SCOPES,
  }
  const metadata = {
    schemaVersion: 1,
    issuer: origin,
    clientId: infrastructure.DEFAULT_CLIENT_ID,
    audience: 'cli',
    scopes: infrastructure.DEFAULT_SCOPES,
    expiresAt: credential.expiresAt,
    identity: key,
    updatedAt: now,
  }
  const run = async (args, overrides = {}) => {
    try {
      return {
        code: 0,
        ...(await execFileAsync(
          process.execPath,
          [
            cli,
            ...args.slice(0, args[0] === 'sync' ? 2 : 1),
            ...flags,
            ...args.slice(args[0] === 'sync' ? 2 : 1),
          ],
          {
            cwd: root,
            env: { ...environment, ...overrides },
            encoding: 'utf8',
            timeout: 30_000,
          },
        )),
      }
    } catch (error) {
      return error
    }
  }
  const success = async (args) => {
    const result = await run(args)
    assert.equal(result.code, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const failure = async (args, overrides) => {
    const result = await run(args, overrides)
    assert.notEqual(result.code, 0)
    if (args[0] === 'exec') return { data: JSON.parse(result.stdout).error }
    return parseEnvelope(result.stderr)
  }
  try {
    await credentials.set(key, credential)
    await metadataStore.save(metadata)
    await success(['init', '--json'])
    const started = await success(['start', '--json'])
    const hostedId = sessionId
    const localId = started.data.sandbox.id
    assert.equal(creates, 1)
    const status = await success(['status', '--json'])
    assert.equal(status.data.sandbox.id, localId)
    const source = join(root, 'source')
    await mkdir(source)
    await writeFile(join(source, 'a.txt'), 'uploaded a\n')
    await writeFile(join(source, 'b.txt'), 'uploaded b\n')
    await writeFile(join(source, 'c.txt'), 'uploaded c\n')
    const pushArgs = ['sync', 'push', '--local-dir', source, '--json']
    const pushed = await success(pushArgs)
    assert.deepEqual(pushed.data.uploadedFiles, ['a.txt', 'b.txt', 'c.txt'])
    assert.equal(pushed.data.uploadedBytes, 33)
    assert.equal(sourceCreates, 1)
    assert.equal(delivered, 1)
    const uploaded = await success(['exec', '--json', '--', 'cat', 'a.txt'])
    assert.equal(Buffer.from(uploaded.stdout.data, 'base64').toString(), 'uploaded a\n')
    assert.equal(uploaded.result.exitCode, 0)
    const humanCat = await run(['exec', '--', 'cat', 'a.txt'])
    assert.equal(humanCat.code, 0, humanCat.stderr)
    assert.equal(humanCat.stdout, 'uploaded a\n')
    const beforeChunks = chunkUploads
    const repeated = await success(pushArgs)
    assert.equal(repeated.data.applied, false)
    assert.deepEqual(repeated.data.uploadedFiles, [])
    assert.equal(repeated.data.uploadedBytes, 0)
    assert.equal(chunkUploads, beforeChunks)
    assert.equal(sourceCreates, 1)
    assert.equal(delivered, 1)
    await writeFile(join(source, 'a.txt'), 'changed a\n')
    await success(pushArgs)
    assert.equal((await run(['exec', '--', 'cat', 'a.txt'])).stdout, 'changed a\n')
    await writeFile(join(source, 'a.txt'), 'uploaded a\n')
    await success(pushArgs)
    assert.equal((await run(['exec', '--', 'cat', 'a.txt'])).stdout, 'uploaded a\n')
    assert.equal(delivered, 3, 'returning to an earlier snapshot must deliver again')
    const afterRevert = chunkUploads
    assert.equal((await success(pushArgs)).data.uploadedBytes, 0)
    assert.equal(chunkUploads, afterRevert)
    await writeFile(join(source, 'large.txt'), Buffer.alloc(65537))
    const tooLarge = await failure(pushArgs)
    assert.equal(tooLarge.data.code, 'SYNC_TOO_LARGE')
    assert.match(tooLarge.data.message, /large\.txt.*65537.*--exclude/)
    assert.equal(chunkUploads, afterRevert)
    await success([...pushArgs, '--exclude', 'large.txt'])
    for (const command of ['pull', 'diff']) {
      const unsupported = await failure(['sync', command, '--local-dir', source, '--json'])
      assert.equal(unsupported.data.code, 'CAPABILITY_UNSUPPORTED')
      assert.match(unsupported.data.message, /not supported for hosted sandboxes yet/)
    }
    await assert.rejects(
      readFile(
        join(
          state,
          'sync',
          started.data.session.projectId,
          started.data.session.id,
          'remote',
          'a.txt',
        ),
      ),
      { code: 'ENOENT' },
    )
    process.stdout.write(
      'CLI hosted sync E2E passed (3 files, project cwd exec, unchanged push, size limit, unsupported pull/diff)\n',
    )
    const executed = await success(['exec', '--json', '--', 'echo', 'mock'])
    assert.equal(executed.result.exitCode, 0)

    assert.equal((await failure(['cancel', '--json'])).data.code, 'INVALID_STATE')
    longExecution = true
    const firstExecutionCall = calls.length
    const running = run(['exec', '--json', '--', 'sleep', '600'])
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (
        calls
          .slice(firstExecutionCall)
          .some(([, path]) => path.endsWith('/hosted_execution/events'))
      )
        break
      await delay(25)
      assert(attempt < 199, 'exec must start before cancellation')
    }
    const cancelled = await success(['cancel', '--sandbox', localId, '--json'])
    assert.equal(cancelled.data.state, 'cancelled')
    assert.equal(cancelled.data.executionId, 'hosted_execution')
    const ended = await running
    assert.equal(ended.code, 130)
    assert.equal(JSON.parse(ended.stdout).outcome, 'cancelled')
    const cancelCalls = calls.filter(([, path]) => path.endsWith('/hosted_execution/cancel')).length
    assert.equal((await success(['cancel', 'hosted_execution', '--json'])).data.state, 'cancelled')
    assert.equal(
      calls.filter(([, path]) => path.endsWith('/hosted_execution/cancel')).length,
      cancelCalls,
    )
    assert.equal((await failure(['cancel', '--json'])).data.code, 'INVALID_STATE')
    assert.equal((await failure(['cancel', 'unknown', '--json'])).data.code, 'SANDBOX_NOT_FOUND')
    longExecution = false

    // A rotated token in the same login retains the mapping across processes.
    await credentials.set(key, { ...credential, expiresAt: new Date(0).toISOString() })
    await success(['status', '--json'])
    assert.equal(refreshes, 1)

    // The fixed default credential slot is insufficient: a new login must not
    // inherit the former login's mapping even if its server accepts the same IDs.
    const sessionCalls = () => calls.filter(([, path]) => path.startsWith('/v1/sessions/')).length
    let before = sessionCalls()
    await metadataStore.save({ ...metadata, updatedAt: new Date(Date.now() + 1000).toISOString() })
    assert.equal((await failure(['status', '--json'])).data.code, 'SANDBOX_NOT_FOUND')
    assert.equal((await failure(pushArgs)).data.code, 'SANDBOX_NOT_FOUND')
    assert.equal(
      (await failure(['cancel', 'hosted_execution', '--json'])).data.code,
      'SANDBOX_NOT_FOUND',
    )
    assert.equal(
      (await failure(['exec', '--json', '--', 'echo', 'mock'])).data.code,
      'SANDBOX_NOT_FOUND',
    )
    assert.equal(sessionCalls(), before)
    await metadataStore.save(metadata)
    await metadataStore.save({ ...metadata, issuer: otherOrigin })
    assert.equal(
      (await failure(['status', '--json'], { OCBOX_API_URL: otherOrigin })).data.code,
      'SANDBOX_NOT_FOUND',
    )
    assert.equal(sessionCalls(), before)
    await metadataStore.save(metadata)
    assert.equal(
      (await failure(['status', '--json'], { OCBOX_PROJECT_ID: 'other_project' })).data.code,
      'SANDBOX_NOT_FOUND',
    )
    assert.equal(sessionCalls(), before)

    const stopped = await success(['stop', '--json'])
    assert.equal(stopped.data.sandbox.id, localId)
    assert.equal(stopped.data.session.state, 'stopped')
    const destroyed = await success(['destroy', '--yes', '--json'])
    assert.equal(destroyed.data.session.state, 'destroyed')
    assert.equal(creates, 1)
    for (const action of ['executions', 'stop', 'destroy']) {
      assert.equal(
        calls.some(
          ([method, path]) => method === 'POST' && path === `/v1/sessions/${hostedId}/${action}`,
        ),
        true,
      )
    }

    await success(['start', '--new', '--json'])
    missing = true
    const stale = await failure(['status', '--json'])
    assert.equal(stale.data.code, 'SANDBOX_NOT_FOUND')
    assert.equal(stale.data.providerCode, 'HOSTED_MAPPING_STALE')
    assert.match(stale.data.message, /mapping is stale/)
    before = sessionCalls()
    for (const args of [
      ['start', '--json'],
      ['exec', '--json', '--', 'echo', 'mock'],
      ['stop', '--json'],
      ['destroy', '--yes', '--json'],
    ]) {
      const error = await failure(args)
      assert.equal(error.data.code, 'SANDBOX_NOT_FOUND')
      assert.match(error.data.message, /mapping is stale/)
      if (args[0] !== 'exec') assert.equal(error.data.providerCode, 'HOSTED_MAPPING_STALE')
    }
    assert.equal(
      sessionCalls(),
      before,
      'persisted stale mapping must fail before any hosted session call',
    )
    assert.equal(creates, 2, 'stale mapping must never create a replacement')
    process.stdout.write(
      'CLI hosted lifecycle E2E passed (cross-process start/status/exec/stop/destroy, refresh, scope isolation, persistent stale 404)\n',
    )
  } finally {
    for (const instance of [server, otherServer]) {
      await new Promise((done) => {
        instance.close(done)
        instance.closeAllConnections()
      })
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

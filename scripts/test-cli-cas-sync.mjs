import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const infrastructure = await import(pathToFileURL(join(repo, 'dist/infrastructure.js')).href)
const root = await mkdtemp(join(tmpdir(), 'ocbox-cas-e2e-'))
const source = join(root, 'source'),
  state = join(root, 'state'),
  platform = join(root, 'platform')
await mkdir(source)
const requestId = '11111111-1111-4111-8111-111111111111'
const now = new Date().toISOString(),
  sessionId = 'sesdo_localtest'
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(path|pathext|systemroot|windir|comspec|temp|tmp)$/i.test(key),
    ),
  ),
  HOME: platform,
  XDG_CONFIG_HOME: platform,
  XDG_STATE_HOME: platform,
  APPDATA: platform,
  LOCALAPPDATA: platform,
  USERPROFILE: platform,
  NO_COLOR: '1',
  OCBOX_PROJECT_ID: 'test_project',
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const canonicalHash = (value) => {
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical(v[k])]),
          )
        : v
  return hash(JSON.stringify(canonical(value)))
}
const blobs = new Map(),
  plans = new Map(),
  keys = new Map(),
  tree = new Map()
let owned = new Set(),
  accepted = [],
  maxConcurrent = 0,
  concurrent = 0,
  applies = 0
let interrupt = false,
  refusal = false,
  expired = false,
  activeChild,
  interruptedPlan,
  created = false,
  failure
const session = {
  id: sessionId,
  projectId: 'test_project',
  createdAt: now,
  updatedAt: now,
  requestedSpec: {},
  effectiveSpec: {},
  normalizedState: 'running',
  rawState: 'running',
  primarySandboxId: 'box_localtest',
  sandboxes: [
    {
      ordinal: 0,
      role: 'primary',
      active: true,
      state: 'running',
      sandboxId: 'box_localtest',
      boundAt: now,
      releasedAt: null,
    },
  ],
}
const operation = {
  id: 'operation_create',
  kind: 'session_create',
  createdAt: now,
  updatedAt: now,
  projectId: 'test_project',
  sessionId,
  state: 'succeeded',
  progress: 100,
  requestId,
  error: null,
  resource: null,
}
let origin
const server = createServer(async (req, res) => {
  const send = (body, status = 200) =>
    res
      .writeHead(status, { 'content-type': 'application/json', 'x-request-id': requestId })
      .end(JSON.stringify(body))
  try {
    const url = new URL(req.url, origin),
      path = url.pathname
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    if (req.method === 'PUT') {
      // Deliberately opaque paths: no hash suffix and same API origin with a capability query.
      assert.equal(req.headers.authorization, undefined)
      assert.equal(req.headers['idempotency-key'], undefined)
      const digest = url.searchParams.get('cap')
      assert.equal(hash(bytes), digest)
      const interruptThisUpload = interrupt
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      try {
        await new Promise((done) => setTimeout(done, 80))
        if (interruptThisUpload && accepted.length >= 1) return send({}, 503)
        blobs.set(digest, bytes)
        accepted.push(digest)
        send({}, 200)
        if (interruptThisUpload) setTimeout(() => activeChild?.kill('SIGINT'), 10)
      } finally {
        concurrent--
      }
      return
    }
    assert.match(req.headers.authorization ?? '', /^Bearer /)
    const body = bytes.length ? JSON.parse(bytes) : undefined
    if (path === '/v1/projects/test_project')
      return send({ id: 'test_project', name: 'test', createdAt: now, updatedAt: now })
    if (path === '/v1/projects/test_project/sessions' && req.method === 'POST') {
      created = true
      return send(operation, 202)
    }
    if (path === '/v1/projects/test_project/sessions')
      return send({ data: created ? [session] : [], nextCursor: null })
    if (path === `/v1/sessions/${sessionId}`) return send(session)
    if (path === '/v1/operations/operation_create') return send(operation)
    assert(
      !path.includes('/source/manifests'),
      'fast-path boxes must not call the legacy manifest route',
    )
    const action = path.split('/').at(-1)
    assert.equal(req.method, 'POST')
    assert.equal(body.version, 2)
    const key = req.headers['idempotency-key']
    assert.equal(typeof key, 'string')
    if (keys.has(key)) assert.deepEqual(keys.get(key), body, 'idempotency replay changed its body')
    keys.set(key, body)
    if (refusal)
      return send(
        {
          error: { code: 'FORBIDDEN', message: 'untrusted response text ?cap=do-not-print' },
          requestId,
        },
        403,
      )
    if (expired)
      return send(
        { error: { code: 'CONFLICT', message: 'untrusted', reason: 'plan_expired' }, requestId },
        409,
      )
    if (action === 'plan') {
      assert.equal(path, `/v1/sessions/${sessionId}/source/cas/plan`)
      const { manifest, page } = body
      assert.equal(
        canonicalHash({ files: page.files, blobs: page.blobs }),
        manifest.pageHashes[page.index],
      )
      assert(page.files.length <= 512)
      assert(Buffer.byteLength(JSON.stringify(page)) <= 524288)
      let plan = plans.get(manifest.syncId)
      if (!plan) {
        plan = {
          manifest,
          id: `casdo_${String(plans.size + 1).padStart(30, '0')}`,
          pages: new Map(),
          state: 'uploading',
          polls: 0,
        }
        plans.set(manifest.syncId, plan)
      }
      assert.deepEqual(plan.manifest, manifest)
      if (interrupt) interruptedPlan = plan.id
      plan.pages.set(page.index, page)
      return send({
        version: 2,
        planId: plan.id,
        state: plan.state,
        replayed: false,
        expiresAt: Date.now() + 900000,
        missing:
          plan.state === 'uploading'
            ? page.blobs
                .filter((blob) => !blobs.has(blob.hash))
                .map((blob) => ({ ...blob, url: `${origin}/opaque-upload?cap=${blob.hash}` }))
            : [],
      })
    }
    assert.equal(path, `/v1/sessions/${sessionId}/source/cas/apply`)
    const plan = [...plans.values()].find((p) => p.id === body.planId)
    assert(plan)
    assert.equal(plan.pages.size, plan.manifest.pageHashes.length)
    applies++
    if (++plan.polls === 1)
      return send(
        {
          version: 2,
          planId: plan.id,
          state: 'pending',
          replayed: false,
          expiresAt: Date.now() + 900000,
        },
        202,
      )
    if (plan.state !== 'succeeded') {
      const files = [...plan.pages.values()]
        .sort((a, b) => a.index - b.index)
        .flatMap((p) => p.files)
      assert.equal(files.length, plan.manifest.fileCount)
      const desired = new Set()
      let total = 0
      for (const file of files) {
        desired.add(file.path)
        if (file.type === 'directory') continue
        const content = Buffer.concat(
          file.parts.map((part) => {
            const blob = blobs.get(part.hash)
            assert(blob)
            assert.equal(hash(blob), part.hash)
            assert(part.offset + part.size <= blob.length)
            return blob.subarray(part.offset, part.offset + part.size)
          }),
        )
        assert.equal(content.length, file.size)
        assert.equal(hash(content), file.hash)
        assert([420, 493].includes(file.mode))
        total += content.length
        tree.set(file.path, content)
      }
      assert.equal(total, plan.manifest.totalBytes)
      for (const path of owned) if (!desired.has(path)) tree.delete(path)
      owned = desired
      plan.state = 'succeeded'
    }
    return send({
      version: 2,
      planId: plan.id,
      state: 'succeeded',
      replayed: plan.polls > 2,
      expiresAt: Date.now() + 900000,
    })
  } catch (error) {
    failure = error
    send({}, 500)
  }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
origin = `http://127.0.0.1:${server.address().port}`
env.OCBOX_API_URL = origin
const exec = promisify(execFile)
const flags = ['--config', join(root, 'opencloudbox.toml'), '--state-dir', state]
async function run(args) {
  const child = exec(process.execPath, [join(repo, 'dist/index.js'), ...args, ...flags], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 45000,
    maxBuffer: 8 * 1024 * 1024,
  })
  activeChild = child.child
  try {
    return { code: 0, ...(await child) }
  } catch (error) {
    return error
  } finally {
    activeChild = undefined
  }
}
const push = (extra = []) => run(['sync', 'push', '--local-dir', source, ...extra])
const events = (output) =>
  output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
const result = (output) => events(output).find((e) => e.kind === 'result').data
async function success(pending, jsonl = false) {
  const r = await pending
  if (failure) throw failure
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stderr, '')
  return jsonl ? result(r.stdout) : JSON.parse(r.stdout).data
}
try {
  const credentials = new infrastructure.ProtectedFileCredentialStore(
    infrastructure.resolveCurrentPlatformPaths(env).credentialDirectory,
  )
  const identity = { kind: 'hosted-oauth', provider: 'ocbox', accountId: 'default' }
  const credential = {
    tokenType: 'Bearer',
    accessToken: 'local_test_access',
    refreshToken: 'local_test_refresh',
    expiresAt: new Date(Date.now() + 900000).toISOString(),
    scopes: infrastructure.DEFAULT_SCOPES,
  }
  await credentials.set(identity, credential)
  await new infrastructure.AuthMetadataStore(join(state, 'auth.json')).save({
    schemaVersion: 1,
    issuer: origin,
    clientId: infrastructure.DEFAULT_CLIENT_ID,
    audience: 'cli',
    scopes: credential.scopes,
    expiresAt: credential.expiresAt,
    identity,
    updatedAt: now,
  })
  await success(run(['init', '--json']))
  await success(run(['start', '--json']))
  // Real codecs and bytes: thousands of files and four distinct 16 MiB parts.
  for (let i = 0; i < 1100; i++)
    await writeFile(join(source, `f${String(i).padStart(4, '0')}.js`), `module.exports=${i}\n`)
  const large = Buffer.alloc(64 * 1024 * 1024)
  for (let i = 0; i < 4; i++) large.fill(i + 1, i * 16 * 1024 * 1024, (i + 1) * 16 * 1024 * 1024)
  await writeFile(join(source, 'large.bin'), large)
  await writeFile(join(source, '.gitignore'), 'ignored.txt\n')
  await writeFile(join(source, 'ignored.txt'), 'excluded')
  await mkdir(join(source, 'node_modules'))
  await writeFile(join(source, 'node_modules/hidden'), 'excluded')
  const first = await success(push(['--jsonl']), true)
  assert.equal(first.protocolVersion, 2)
  assert.equal(first.uploadedBlobs, 5)
  assert.equal(tree.size, 1102)
  assert.deepEqual(tree.get('large.bin'), large)
  assert(maxConcurrent > 1 && maxConcurrent <= 4)
  assert(applies >= 2)
  const unchanged = await success(push(['--json']))
  assert.equal(unchanged.uploadedBlobs, 0)
  accepted = []
  for (let i = 0; i < 3; i++) await writeFile(join(source, `f000${i}.js`), `changed${i}`)
  const second = await success(push(['--json']))
  assert.equal(second.uploadedBlobs, 3)
  assert.equal(accepted.length, 3)
  assert.equal(second.uploadedBytes, 24)
  tree.set('agent-created.txt', Buffer.from('preserve'))
  // Interrupt a fresh process after one accepted blob. Pending state survives restart.
  for (let i = 3; i < 8; i++) await writeFile(join(source, `f000${i}.js`), `resume${i}`)
  accepted = []
  interrupt = true
  const interrupted = await push(['--jsonl'])
  assert.notEqual(interrupted.code, 0)
  assert.equal(JSON.parse(interrupted.stderr).data.code, 'OPERATION_CANCELLED')
  assert.equal(accepted.length, 1)
  const acceptedBeforeResume = accepted[0],
    countBeforeResume = plans.size
  while (concurrent) await new Promise((done) => setTimeout(done, 10))
  interrupt = false
  accepted = []
  const resumed = await success(push(['--json']))
  assert.equal(resumed.operationId, interruptedPlan)
  assert.equal(plans.size, countBeforeResume)
  assert.equal(resumed.uploadedBlobs, 4)
  assert(!accepted.includes(acceptedBeforeResume))
  assert.equal(tree.get('agent-created.txt').toString(), 'preserve')
  await rm(join(source, 'f0009.js'))
  const deletion = await push(['--json'])
  assert.equal(deletion.code, 1)
  assert.equal(JSON.parse(deletion.stderr).data.code, 'SYNC_CONFLICT')
  await success(push(['--delete', '--yes', '--json']))
  assert(!tree.has('f0009.js'))
  assert(tree.has('agent-created.txt'))
  refusal = true
  const refused = await push(['--json'])
  assert.equal(refused.code, 1)
  assert.equal(refused.stdout, '')
  assert.equal(JSON.parse(refused.stderr).data.code, 'AUTH_FORBIDDEN')
  assert(!refused.stderr.includes('do-not-print'))
  refusal = false
  expired = true
  const expiredPush = await push(['--json'])
  assert.equal(expiredPush.code, 1)
  assert.equal(JSON.parse(expiredPush.stderr).data.code, 'SYNC_FAILED')
  expired = false
  const afterExpiry = await success(push(['--json']))
  assert.equal(afterExpiry.uploadedBlobs, 0)
  const stateFiles = await readdir(state, { recursive: true })
  for (const file of stateFiles.filter((p) => /cas.*(?:state|pending)\.json$/.test(p))) {
    const text = await readFile(join(state, file), 'utf8')
    assert(!text.includes('?cap='))
    assert(!text.includes('local_test_access'))
    assert(!text.includes(root))
  }
  assert(!failure)
  process.stdout.write(
    'CLI CAS sync E2E passed (1100 files + 64 MiB, delta=3, interrupted resume, mirror ownership, safe refusal)\n',
  )
} finally {
  activeChild?.kill('SIGKILL')
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  await rm(root, { recursive: true, force: true })
}

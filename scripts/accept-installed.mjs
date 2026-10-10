#!/usr/bin/env node
/**
 * Fresh npm-installed hosted journey. stdout is JSONL evidence; stderr is progress
 * and, only for manual login, the public authorization URL. No CLI/mail bodies
 * or credentials enter evidence. Run with the repository contributor toolchain
 * after installing the repository dependencies from the lockfile.
 *
 * node scripts/accept-installed.mjs --self-test
 * node scripts/accept-installed.mjs --api-url <hosted API origin>
 * Optional live env: OCB_TEST_MAILBOX_API_KEY, OCB_TEST_MAILBOX_NAMESPACE,
 * OCB_TEST_MAILBOX_API_URL, OCB_TEST_MAILBOX_DOMAIN, OCB_ACCEPT_WEB_ORIGIN.
 * npm install uses a loopback registry of the installed runtime dependency graph,
 * so neither mode needs the public npm registry or the operator's npm credentials.
 */
import nodeAssert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

class CheckFailure extends Error {
  constructor(check, status) {
    super(check)
    this.check = check
    this.status = status
  }
}

// Only labels supplied by this harness can cross the evidence boundary.
const labeledAssertion =
  (fn, messageIndex) =>
  (...args) => {
    try {
      return fn(...args)
    } catch {
      const label = args[messageIndex]
      throw new CheckFailure(
        typeof label === 'string' && /^[a-z_]{1,64}$/.test(label) ? label : 'assertion_failed',
        args[messageIndex + 1],
      )
    }
  }
const assert = Object.assign(
  labeledAssertion(nodeAssert, 1),
  Object.fromEntries(
    ['equal', 'deepEqual', 'match'].map((name) => [name, labeledAssertion(nodeAssert[name], 2)]),
  ),
)
function checkStatus(response, label, expected) {
  if (
    expected === undefined
      ? response.status < 200 || response.status >= 300
      : response.status !== expected
  )
    throw new CheckFailure(label, response.status)
}
export function failureEvidence(error) {
  return error instanceof CheckFailure
    ? {
        failure: 'assertion_failed',
        check: error.check,
        ...(Number.isInteger(error.status) ? { httpStatus: error.status } : {}),
      }
    : { failure: 'operation_failed' }
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const limits = { command: 120_000, login: 240_000, build: 180_000, body: 2 * 1024 * 1024 }
const scopes = ['source:read', 'product:read', 'product:edit', 'product:run']
const expected = 'installed acceptance a\n'
const children = new Set()
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

// .cmd shims cannot be spawned without a shell on Windows. Locate their JS
// entrypoints beside Node or the global package-manager shims instead.
function packageManager(name) {
  if (process.platform !== 'win32') return name
  const paths = [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter)]
  const entries =
    name === 'npm'
      ? [join('npm', 'bin', 'npm-cli.js')]
      : [join('corepack', 'dist', 'pnpm.js'), join('pnpm', 'bin', 'pnpm.cjs')]
  for (const path of paths) {
    for (const entry of entries) {
      const candidate = join(path, 'node_modules', entry)
      if (existsSync(candidate)) return [process.execPath, candidate]
    }
  }
  throw new CheckFailure('package_manager_missing')
}

export function redact(value) {
  if (typeof value === 'string')
    return value
      .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      .replace(
        /([?&](?:token|apikey|code|state|code_challenge|code_verifier|challenge|userId|secret)=)[^&\s]+/gi,
        '$1[redacted]',
      )
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\beyJ[A-Za-z0-9_.-]+/g, '[redacted]')
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]))
  return value
}

export function parseArgs(argv) {
  let selfTest = false
  let verbose = false
  let apiUrl
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--self-test' && !selfTest) selfTest = true
    else if (argv[i] === '--verbose' && !verbose) verbose = true
    else if (argv[i] === '--api-url' && !apiUrl) apiUrl = argv[++i]
    else throw new Error('usage')
  }
  if (selfTest === Boolean(apiUrl)) throw new Error('usage')
  if (apiUrl) {
    const url = new URL(apiUrl)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('usage')
    apiUrl = url.origin
  }
  return { selfTest, apiUrl, verbose }
}

export function privateEnvironment(root) {
  const names = new Set(['path', 'pathext', 'systemroot', 'systemdrive', 'windir', 'comspec'])
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => names.has(name.toLowerCase())),
    ),
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'localappdata'),
    TMPDIR: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    NO_COLOR: '1',
    NPM_CONFIG_USERCONFIG: join(root, 'npmrc'),
    NPM_CONFIG_GLOBALCONFIG: join(root, 'global-npmrc'),
    NPM_CONFIG_CACHE: join(root, 'npm-cache'),
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  }
}

// Every command is its own process. Capture is bounded and never dumped on error.
function launch(
  command,
  args,
  { cwd, env, timeout = limits.command, onEvent, onTrace, onComplete } = {},
) {
  const started = Date.now()
  if (Array.isArray(command)) {
    args = [...command.slice(1), ...args]
    command = command[0]
  }
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  children.add(child)
  let stdout = '',
    stderr = '',
    pendingError = '',
    pending = '',
    timedOut = false,
    overflow = false
  let bytes = 0
  const events = []
  const done = new Promise((finish) => {
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeout)
    const capture = (stream, chunk) => {
      bytes += chunk.length
      if (bytes > limits.body) {
        overflow = true
        child.kill('SIGKILL')
        return
      }
      if (stream === 'stderr') {
        stderr += chunk.toString()
        pendingError += chunk.toString()
        let newline = pendingError.indexOf('\n')
        while (newline >= 0) {
          const line = pendingError.slice(0, newline)
          pendingError = pendingError.slice(newline + 1)
          if (line.startsWith('accept-http:')) {
            try {
              onTrace?.(JSON.parse(line.slice('accept-http:'.length)))
            } catch {
              /* private stream */
            }
          }
          newline = pendingError.indexOf('\n')
        }
        return
      }
      stdout += chunk.toString()
      pending += chunk.toString()
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        let event
        try {
          event = JSON.parse(line)
        } catch {
          /* tool progress is not an envelope */
        }
        if (event) {
          events.push(event)
          onEvent?.(event)
        }
        newline = pending.indexOf('\n')
      }
    }
    child.stdout.on('data', (chunk) => capture('stdout', chunk))
    child.stderr.on('data', (chunk) => capture('stderr', chunk))
    const complete = (code, signal, spawnError = false) => {
      clearTimeout(timer)
      children.delete(child)
      const result = {
        code,
        signal,
        spawnError,
        timedOut,
        overflow,
        stdout,
        stderr,
        events,
        durationMs: Date.now() - started,
      }
      onComplete?.(result)
      finish(result)
    }
    child.on('error', () => complete(null, null, true))
    child.on('close', (code, signal) => complete(code, signal))
  })
  return { child, done }
}
const run = (command, args, options) => launch(command, args, options).done
function checkProcess(result, code = 0) {
  assert(!result.timedOut && !result.overflow && !result.spawnError, 'process_boundary')
  assert(result.code === code, 'exit_code')
}
function envelope(result, name) {
  checkProcess(result)
  const found = result.events.filter((event) => event.kind === 'result' && event.name === name)
  assert.equal(found.length, 1, 'result_envelope')
  assert.equal(found[0].schemaVersion, 1, 'schema_version')
  return found[0].data
}
async function listen(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Mock assertion failed' } }),
      )
    })
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    stop: () =>
      new Promise((done) => {
        server.close(done)
        server.closeAllConnections()
      }),
  }
}

// Serve actual package archives, never symlink/copy dependencies into the prefix.
// Resolve from each parent's installed dependency tree, supporting pnpm layouts.
export async function dependencyRegistry(root, npm, env) {
  const versions = new Map()
  const queue = [
    { directory: repo, manifest: JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')) },
  ]
  while (queue.length) {
    const { directory, manifest } = queue.shift()
    const require = createRequire(join(directory, 'package.json'))
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      const location = require.resolve
        .paths(name)
        ?.map((path) => join(path, name, 'package.json'))
        .find(existsSync)
      if (!location) {
        if (manifest.optionalDependencies?.[name]) continue
        throw new CheckFailure('dependency_missing')
      }
      const path = await realpath(location)
      const dependency = JSON.parse(await readFile(path, 'utf8'))
      const key = `${name}@${dependency.version}`
      if (versions.has(key)) continue
      versions.set(key, { manifest: dependency, directory: dirname(path) })
      queue.push({ directory: dirname(path), manifest: dependency })
    }
  }
  const archives = join(root, 'dependencies')
  await mkdir(archives)
  for (const record of versions.values()) {
    // npm 11 cannot reliably pack a folder inside pnpm's node_modules tree.
    // Stage package files privately; the installed prefix still gets only tgzs.
    const staging = join(root, 'dependency-stage')
    await cp(record.directory, staging, {
      recursive: true,
      filter: (path) => !relative(record.directory, path).split(sep).includes('node_modules'),
    })
    // Run from our scratch root, not a dependency's development environment.
    const packed = await run(
      npm,
      ['pack', staging, '--ignore-scripts', '--offline', '--json', '--pack-destination', archives],
      { cwd: root, env },
    )
    if (packed.code !== 0) {
      const error = new CheckFailure('dependency_pack')
      error.package = record.manifest.name
      error.exitCode = packed.code
      error.npmCode = /^npm error code ([A-Z_0-9]+)$/m.exec(packed.stderr)?.[1]
      throw error
    }
    checkProcess(packed)
    const [info] = JSON.parse(packed.stdout)
    record.bytes = await readFile(join(archives, info.filename))
    record.shasum = createHash('sha1').update(record.bytes).digest('hex')
    await rm(staging, { recursive: true, force: true })
  }
  let registry
  registry = await listen((request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(1))
    const record = versions.get(path)
    if (record)
      return response
        .writeHead(200, { 'content-type': 'application/octet-stream' })
        .end(record.bytes)
    const records = [...versions.values()].filter((entry) => entry.manifest.name === path)
    if (!records.length) return response.writeHead(404).end('{}')
    const data = Object.fromEntries(
      records.map((entry) => [
        entry.manifest.version,
        {
          ...entry.manifest,
          dist: {
            shasum: entry.shasum,
            tarball: `${registry.origin}/${encodeURIComponent(`${path}@${entry.manifest.version}`)}`,
          },
        },
      ]),
    )
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        name: path,
        'dist-tags': { latest: records.at(-1).manifest.version },
        versions: data,
      }),
    )
  })
  return registry
}

// HTTP bodies stay private and bounded, including test mailbox responses and cookies.
async function request(url, init = {}, onTrace) {
  const started = Date.now()
  let status = null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal })
    status = response.status
    let text = '',
      size = 0
    for await (const chunk of response.body ?? []) {
      size += chunk.length
      assert(size <= limits.body, 'http_body_limit')
      text += Buffer.from(chunk).toString()
    }
    let json
    try {
      json = JSON.parse(text)
    } catch {
      /* HTML callback/consent page */
    }
    return { status: response.status, headers: response.headers, json, text }
  } catch (error) {
    if (error instanceof CheckFailure) throw error
    throw new CheckFailure('http_request_failed')
  } finally {
    clearTimeout(timer)
    onTrace?.({
      method: init.method ?? 'GET',
      path: safeHttpPath(new URL(url).pathname),
      status,
      durationMs: Date.now() - started,
    })
  }
}

// Trace route templates only; resource identifiers and query values stay private.
export function safeHttpPath(path) {
  if (
    /^\/v1\/auth\/(?:magic-links|browser\/magic-links\/consume|sessions\/current|cli\/(?:authorize|token)|revoke)$/.test(
      path,
    )
  )
    return path
  if (path === '/callback') return path
  if (path.endsWith('/api/json')) return '/api/json'
  const words = new Set([
    'v1',
    'projects',
    'sessions',
    'source',
    'manifests',
    'chunks',
    'checksum',
    'operations',
    'sandboxes',
    'executions',
    'events',
    'cancel',
    'stop',
    'start',
    'destroy',
    'delivery',
    'deliveries',
    'files',
  ])
  return path
    .split('/')
    .map((part) => (!part || words.has(part) ? part : ':id'))
    .join('/')
}

// Loaded only into the isolated installed CLI when verbose tracing is requested.
function installFetchTrace(safePath) {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const started = Date.now()
    let status = null
    try {
      const response = await original(input, init)
      status = response.status
      return response
    } finally {
      const url = new URL(input instanceof Request ? input.url : input)
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      process.stderr.write(
        `accept-http:${JSON.stringify({
          method,
          path: safePath(url.pathname),
          status,
          durationMs: Date.now() - started,
        })}\n`,
      )
    }
  }
}

export function validateAuthorization(raw, apiOrigin) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new CheckFailure('authorization_url')
  }
  assert.equal(url.origin, apiOrigin, 'authorization_origin')
  assert.equal(url.pathname, '/v1/auth/cli/authorize', 'authorization_path')
  assert(!url.username && !url.password && !url.hash, 'authorization_url')
  assert.deepEqual(
    [...url.searchParams.keys()].sort(),
    [
      'audience',
      'client_id',
      'code_challenge',
      'code_challenge_method',
      'redirect_uri',
      'response_type',
      'scope',
      'state',
    ],
    'authorization_parameters',
  )
  assert.equal(url.searchParams.get('response_type'), 'code', 'authorization_binding')
  assert.equal(url.searchParams.get('client_id'), 'ocb_cli', 'authorization_binding')
  assert.equal(url.searchParams.get('audience'), 'cli', 'authorization_binding')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256', 'authorization_binding')
  assert.match(
    url.searchParams.get('code_challenge'),
    /^[A-Za-z0-9_-]{43}$/,
    'authorization_binding',
  )
  assert.match(url.searchParams.get('state'), /^[A-Za-z0-9_-]{16,128}$/, 'authorization_binding')
  assert.deepEqual(
    (url.searchParams.get('scope') ?? '').split(' ').sort(),
    [...scopes].sort(),
    'authorization_scopes',
  )
  let callback
  try {
    callback = new URL(url.searchParams.get('redirect_uri'))
  } catch {
    throw new CheckFailure('authorization_callback')
  }
  assert.equal(callback.hostname, '127.0.0.1', 'authorization_callback')
  assert.equal(callback.protocol, 'http:', 'authorization_callback')
  assert.equal(callback.pathname, '/callback', 'authorization_callback')
  assert(
    callback.port && !callback.username && !callback.password && !callback.search && !callback.hash,
    'authorization_callback',
  )
  return url
}

// Mailbox adapter contract: address(tag) and messages({ tag, since }).
// Keep the HTTP query and response format separate from the browser journey.
export function createMailboxAdapter({ apiUrl, key, namespace, domain, onTrace }) {
  let base
  try {
    base = new URL(apiUrl)
  } catch {
    throw new CheckFailure('mailbox_api_url')
  }
  assert(
    ['http:', 'https:'].includes(base.protocol) &&
      !base.username &&
      !base.password &&
      !base.search &&
      !base.hash,
    'mailbox_api_url',
  )
  assert(typeof key === 'string' && key.length > 0, 'mailbox_api_key')
  assert(typeof namespace === 'string' && /^[A-Za-z0-9_-]+$/.test(namespace), 'mailbox_namespace')
  assert(typeof domain === 'string' && /^[A-Za-z0-9.-]+$/.test(domain), 'mailbox_domain')
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  return {
    address: (tag) => `${namespace}.${tag}@${domain}`,
    async messages({ tag, since }) {
      const url = new URL('api/json', base)
      for (const [name, value] of Object.entries({
        apikey: key,
        namespace,
        tag,
        timestamp_from: String(since),
        livequery: 'false',
      }))
        url.searchParams.set(name, value)
      const response = await request(url, {}, onTrace)
      checkStatus(response, 'mailbox_http_status', 200)
      assert.equal(response.json?.result, 'success', 'mailbox_result')
      assert(Array.isArray(response.json.emails ?? []), 'mailbox_messages', response.status)
      return (response.json.emails ?? [])
        .filter((email) => email.tag === tag && Number(email.timestamp) >= since)
        .map((email) => `${email.text ?? ''}\n${email.html ?? ''}`)
    },
  }
}

// Same browser session for binding cookie, magic-link consume, CSRF and consent.
export function findMagicLink(messages, apiOrigin) {
  for (const message of messages) {
    const content = message.replace(/&amp;/g, '&').replace(/&#(?:0*38|x0*26);/gi, '&')
    for (const match of content.matchAll(/https?:\/\/[^\s<>"']+/g)) {
      let link
      try {
        link = new URL(match[0])
      } catch {
        continue
      }
      if (
        link.origin !== apiOrigin ||
        link.pathname !== '/v1/auth/browser/magic-links/consume' ||
        link.username ||
        link.password ||
        link.hash
      )
        continue
      if (
        ['challenge', 'userId', 'secret'].every(
          (name) => link.searchParams.getAll(name).length === 1 && link.searchParams.get(name),
        )
      )
        return link
    }
  }
}

export async function browserLogin(
  raw,
  { apiOrigin, webOrigin, mailbox, onTrace, mailboxTimeoutMs = 150_000, pollIntervalMs = 2000 },
) {
  const url = validateAuthorization(raw, apiOrigin)
  const cookies = new Map()
  let csrf, primaryFailure
  const browser = async (target, method = 'POST', body, navigation = false) => {
    const response = await request(
      new URL(target, apiOrigin),
      {
        method,
        headers: {
          ...(navigation ? {} : { origin: webOrigin }),
          accept: navigation ? 'text/html' : 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(cookies.size
            ? { cookie: [...cookies].map(([name, cookie]) => `${name}=${cookie.value}`).join('; ') }
            : {}),
          ...(csrf && !navigation ? { 'x-csrf-token': csrf } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      onTrace,
    )
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';')
      const index = pair.indexOf('=')
      if (index < 1) continue
      const name = pair.slice(0, index).trim(),
        value = pair.slice(index + 1)
      if (!value || attributes.some((item) => /^\s*max-age=0\s*$/i.test(item))) cookies.delete(name)
      else cookies.set(name, { value })
    }
    // The echoed header identifies the CSRF cookie without assuming its name.
    const echoed = response.headers.get('x-csrf-token')
    if (
      echoed &&
      [...cookies].some(
        ([name, cookie]) =>
          !['ocb_session', 'ocb_login_bind'].includes(name) && cookie.value === echoed,
      )
    )
      csrf = echoed
    return response
  }
  try {
    const tag = `accept-${randomUUID()}`
    const since = Date.now() - 1000
    const issued = await browser('/v1/auth/magic-links', 'POST', { email: mailbox.address(tag) })
    checkStatus(issued, 'magic_link_request_status')
    assert.equal(issued.json?.accepted, true, 'magic_link_accepted', issued.status)
    assert(cookies.get('ocb_login_bind')?.value, 'binding_cookie_missing', issued.status)
    let link,
      sawMessage = false
    const deadline = Date.now() + mailboxTimeoutMs
    while (Date.now() < deadline && !link) {
      const messages = await mailbox.messages({ tag, since })
      sawMessage ||= messages.length > 0
      link = findMagicLink(messages, apiOrigin)
      if (!link) await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())))
    }
    assert(link, sawMessage ? 'magic_link_not_found' : 'mailbox_deadline')
    const consumed = await browser(link, 'GET', undefined, true)
    checkStatus(consumed, 'consume_status', 303)
    let redirect
    try {
      redirect = new URL(consumed.headers.get('location'), apiOrigin)
    } catch {
      /* checked below */
    }
    assert(
      consumed.headers.get('location') &&
        redirect?.origin === apiOrigin &&
        !redirect.username &&
        !redirect.password &&
        !redirect.hash,
      'consume_redirect',
      consumed.status,
    )
    assert(cookies.get('ocb_session')?.value, 'session_cookie_missing', consumed.status)
    const session = await browser('/v1/auth/sessions/current', 'GET')
    checkStatus(session, 'session_status')
    assert(
      typeof session.json?.userId === 'string' &&
        session.json.userId.length > 0 &&
        session.json.authMethod === 'magic_link',
      'session_binding',
      session.status,
    )
    assert(csrf, 'csrf_missing', session.status)
    const params = url.searchParams
    const binding = {
      clientId: params.get('client_id'),
      redirectUri: params.get('redirect_uri'),
      codeChallenge: params.get('code_challenge'),
      codeChallengeMethod: params.get('code_challenge_method'),
      audience: params.get('audience'),
      scope: params.get('scope'),
      state: params.get('state'),
    }
    let response = await browser('/v1/auth/cli/authorize', 'POST', binding)
    checkStatus(response, 'authorize_status')
    let consent = response.json
    if (consent?.status === 'consent_required') {
      assert(Array.isArray(consent.scopes), 'consent_scopes')
      assert.deepEqual([...consent.scopes].sort(), [...scopes].sort(), 'consent_scopes')
      assert(typeof consent.consentId === 'string' && consent.consentId.length > 0, 'consent_id')
      response = await browser('/v1/auth/cli/authorize', 'POST', {
        ...binding,
        consent: { consentId: consent.consentId, approve: true },
      })
      checkStatus(response, 'authorize_status')
      consent = response.json
    }
    assert.equal(consent?.status, 'authorized', 'authorize_result')
    let callback
    try {
      callback = new URL(consent.redirectUri)
    } catch {
      /* checked below */
    }
    const expectedCallback = new URL(binding.redirectUri)
    assert(
      callback &&
        callback.origin === expectedCallback.origin &&
        callback.pathname === expectedCallback.pathname &&
        !callback.username &&
        !callback.password &&
        !callback.hash,
      'callback_mismatch',
    )
    assert.deepEqual(
      [...callback.searchParams.keys()].sort(),
      ['code', 'state'],
      'callback_mismatch',
    )
    assert.equal(callback.searchParams.get('state'), binding.state, 'callback_mismatch')
    assert(callback.searchParams.get('code'), 'callback_code')
    checkStatus(await request(callback, {}, onTrace), 'loopback_callback', 200)
  } catch (error) {
    primaryFailure = error
  } finally {
    try {
      if (cookies.get('ocb_session')?.value) {
        if (!csrf) await browser('/v1/auth/sessions/current', 'GET')
        const revoked = await browser('/v1/auth/sessions/current', 'DELETE')
        checkStatus(revoked, 'web_logout_status')
      }
    } catch (error) {
      primaryFailure ??= error
    } finally {
      cookies.clear()
    }
  }
  if (primaryFailure) throw primaryFailure
}

async function mappings(stateDirectory) {
  const files = await readdir(stateDirectory, { recursive: true }).catch(() => [])
  const found = []
  for (const file of files.filter((file) => file.endsWith('.json') && !file.includes('auth'))) {
    let document
    try {
      document = JSON.parse(await readFile(join(stateDirectory, file), 'utf8'))
    } catch {
      continue
    }
    for (const group of Object.values(document.hostedMappings ?? {}))
      found.push(...Object.values(group))
  }
  return found
}
export async function cleanupEligibility(stateDirectory) {
  return {
    destroy: (await mappings(stateDirectory)).some((record) => record.hostedSessionId),
    logout: existsSync(join(stateDirectory, 'auth.json')),
  }
}
const safeId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value) ? redact(value) : null
function idsOf(view, records, projectId) {
  const record = records.find((record) => record.localSessionId === view?.session?.id)
  return {
    sessionId: safeId(view?.session?.id),
    sandboxId: safeId(view?.sandbox?.id),
    projectId: safeId(projectId),
    hostedSessionId: safeId(record?.hostedSessionId),
    hostedSandboxId: safeId(record?.hostedSandboxId),
  }
}

export async function main(argv, { loginFault } = {}) {
  const options = parseArgs(argv)
  const npm = packageManager('npm')
  const pnpm = packageManager('pnpm')
  const root = await mkdtemp(join(tmpdir(), 'ocbox-accept-installed-'))
  const env = privateEnvironment(root)
  const project = join(root, `journey-${randomUUID()}`)
  const state = join(root, 'cli-state')
  const prefix = join(root, 'prefix')
  const steps = []
  let currentStep
  const trace = (event, stepName = currentStep) => {
    if (!options.verbose) return
    if (
      !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(event.method) ||
      typeof event.path !== 'string' ||
      !Number.isFinite(event.durationMs) ||
      !(event.status === null || Number.isInteger(event.status))
    )
      return
    process.stderr.write(
      `${JSON.stringify({
        step: stepName,
        substep: 'http',
        method: event.method,
        path: safeHttpPath(event.path),
        status: event.status,
        durationMs: event.durationMs,
      })}\n`,
    )
  }
  let registry,
    mock,
    cli,
    running,
    identity = {},
    driver,
    hostedProjectId
  let interrupted = false
  const interrupt = () => {
    interrupted = true
    for (const child of children) child.kill('SIGKILL')
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  const emit = (item) => process.stdout.write(`${JSON.stringify(redact(item))}\n`)
  const step = async (name, action) => {
    currentStep = name
    process.stderr.write(`Installed acceptance: ${name}\n`)
    const started = Date.now()
    const evidence = { step: name, pass: false, durationMs: 0, exitCode: null, ids: {} }
    try {
      await action(evidence)
      evidence.pass = true
    } catch (error) {
      // Assertion labels are ours. Never echo thrown messages, API bodies or argv.
      Object.assign(evidence, failureEvidence(error))
      if (error?.package) evidence.dependency = error.package
      if (error?.npmCode) evidence.npmErrorCode = error.npmCode
      if (error?.exitCode !== undefined) evidence.dependencyPackExitCode = error.exitCode
    }
    evidence.durationMs = Date.now() - started
    steps.push(evidence)
    emit(evidence)
    return evidence.pass
  }
  const skip = (name, reason) => {
    const evidence = {
      step: name,
      pass: false,
      skipped: true,
      reason,
      durationMs: 0,
      exitCode: null,
      ids: {},
    }
    steps.push(evidence)
    emit(evidence)
  }
  const commandTrace = (stepName, substep, result) => {
    if (options.verbose)
      process.stderr.write(
        `${JSON.stringify({
          step: stepName,
          substep,
          exitCode: result.code,
          durationMs: result.durationMs,
        })}\n`,
      )
  }
  const command = async (substep, executable, args, extra) => {
    const result = await run(executable, args, extra)
    commandTrace(currentStep, substep, result)
    return result
  }
  const invoke = (args, extra = {}) => {
    const invokingStep = currentStep
    return launch(
      process.platform === 'win32' ? process.execPath : cli,
      process.platform === 'win32' ? [cli, ...args] : args,
      {
        cwd: project,
        env,
        onTrace: (event) => trace(event, invokingStep),
        onComplete: (result) => commandTrace(invokingStep, 'cli', result),
        ...extra,
      },
    )
  }
  const structured = async (args, name, evidence) => {
    const result = await invoke([...args, '--jsonl']).done
    evidence.exitCode = result.code
    evidence.timedOut = result.timedOut
    const stderrEvents = result.stderr.split(/\r?\n/).flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
    const error = [...result.events, ...stderrEvents].find((entry) => entry.kind === 'error')
    if (error?.data?.code && /^[A-Z_]{1,64}$/.test(error.data.code))
      evidence.cliErrorCode = error.data.code
    return envelope(result, name)
  }
  const required = async (name, action) => {
    if (!(await step(name, action))) throw new Error('journey_failed')
    if (interrupted) throw new Error('interrupted')
  }
  try {
    for (const path of new Set([
      project,
      state,
      prefix,
      ...[
        'HOME',
        'XDG_CONFIG_HOME',
        'XDG_STATE_HOME',
        'XDG_CACHE_HOME',
        'APPDATA',
        'LOCALAPPDATA',
        'TMPDIR',
      ].map((name) => env[name]),
    ]))
      await mkdir(path, { recursive: true, mode: 0o700 })
    await writeFile(env.NPM_CONFIG_USERCONFIG, '', { mode: 0o600 })
    await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '', { mode: 0o600 })
    env.OCBOX_STATE_DIR = state
    if (options.verbose) {
      const preload = join(root, 'http-trace.mjs')
      await writeFile(preload, `(${installFetchTrace.toString()})(${safeHttpPath.toString()})`, {
        mode: 0o600,
      })
      env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`
    }
    await required('pack-install', async (evidence) => {
      const build = await command('build', pnpm, ['run', 'build'], {
        cwd: repo,
        env,
        timeout: limits.build,
      })
      evidence.buildExitCode = build.code
      checkProcess(build)
      const packed = await command(
        'pack',
        npm,
        ['pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', root],
        { cwd: repo, env },
      )
      evidence.packExitCode = packed.code
      checkProcess(packed)
      const [info] = JSON.parse(packed.stdout)
      evidence.artifactSha256 = sha256(await readFile(join(root, info.filename)))
      registry = await dependencyRegistry(root, npm, env)
      const installed = await command(
        'install',
        npm,
        [
          'install',
          '--prefix',
          prefix,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--registry',
          registry.origin,
          join(root, info.filename),
        ],
        { cwd: root, env },
      )
      evidence.exitCode = installed.code
      checkProcess(installed)
      // Execute npm's bin link with the current Node on Windows; POSIX uses the
      // actual installed executable and its shebang exactly as the user would.
      cli = join(prefix, 'node_modules', '.bin', 'ocbox')
      if (process.platform === 'win32')
        cli = join(prefix, 'node_modules', 'opencloudbox', 'dist', 'index.js')
      assert(existsSync(cli), 'installed_bin')
      evidence.package = info.name
      evidence.version = info.version
      const version = await (process.platform === 'win32'
        ? run(process.execPath, [cli, '--version'], { cwd: project, env })
        : invoke(['--version']).done)
      checkProcess(version)
      assert(version.stdout.includes(info.version), 'installed_version')
    })
    if (options.selfTest) mock = await mockHosted({ loginFault })
    const apiOrigin = mock?.origin ?? options.apiUrl
    env.OCBOX_API_URL = apiOrigin
    const automated =
      options.selfTest ||
      Boolean(process.env.OCB_TEST_MAILBOX_API_KEY && process.env.OCB_TEST_MAILBOX_NAMESPACE)
    const webOrigin =
      mock?.origin ?? process.env.OCB_ACCEPT_WEB_ORIGIN ?? apiOrigin.replace(/\/\/api\./, '//app.')
    await required('login', async (evidence) => {
      let authorizationSeen = false
      const login = invoke(['auth', 'login', '--api-url', apiOrigin, '--no-browser', '--jsonl'], {
        timeout: limits.login,
        onEvent: (event) => {
          if (event.name !== 'auth.authorization_url' || authorizationSeen) return
          authorizationSeen = true
          driver = (async () => {
            validateAuthorization(event.data.url, apiOrigin)
            if (automated)
              await browserLogin(event.data.url, {
                apiOrigin,
                webOrigin,
                onTrace: trace,
                mailbox: createMailboxAdapter({
                  onTrace: trace,
                  apiUrl: mock?.origin ?? process.env.OCB_TEST_MAILBOX_API_URL,
                  key: options.selfTest ? 'mock-key' : process.env.OCB_TEST_MAILBOX_API_KEY,
                  namespace: options.selfTest ? 'mock' : process.env.OCB_TEST_MAILBOX_NAMESPACE,
                  domain: options.selfTest
                    ? 'mailbox.example.test'
                    : process.env.OCB_TEST_MAILBOX_DOMAIN,
                }),
              })
            else
              process.stderr.write(
                `Open this URL to authorize the CLI (waiting up to 240 seconds):\n${event.data.url}\n`,
              )
          })().catch((error) => {
            login.child.kill('SIGKILL')
            throw error
          })
          // Observe immediately; the result is awaited after child exit.
          void driver.catch(() => {})
        },
      })
      const result = await login.done
      evidence.exitCode = result.code
      evidence.timedOut = result.timedOut
      await driver
      assert(authorizationSeen, 'authorization_event')
      assert.equal(envelope(result, 'auth.logged_in')?.loggedIn, true, 'login_result')
      evidence.automated = automated
    })
    await required('init', async (evidence) => {
      for (const [name, content] of [
        ['a.txt', expected],
        ['b.txt', 'installed b\n'],
        ['c.txt', 'installed c\n'],
      ])
        await writeFile(join(project, name), content)
      assert.equal(
        await structured(['init'], 'project.initialized', evidence),
        'created',
        'init_result',
      )
      const config = await readFile(join(project, 'opencloudbox.toml'), 'utf8')
      assert.match(config, /name\s*=\s*"ocbox"/, 'project_config')
      assert.match(config, /projectId\s*=/, 'project_config')
      hostedProjectId = /^projectId\s*=\s*"([^"]+)"/m.exec(config)?.[1]
      assert(hostedProjectId, 'project_id')
      evidence.ids = { projectId: safeId(hostedProjectId) }
    })
    await required('start', async (evidence) => {
      const view = await structured(['start'], 'session.started', evidence)
      assert.equal(view?.session?.state, 'active', 'session_active')
      identity = idsOf(view, await mappings(state), hostedProjectId)
      assert(identity.hostedSessionId && identity.hostedSandboxId, 'hosted_mapping')
      evidence.ids = identity
    })
    await required('sync-push', async (evidence) => {
      const result = await structured(['sync', 'push'], 'sync.pushed', evidence)
      assert(Array.isArray(result?.uploadedFiles), 'uploaded_files')
      for (const file of ['a.txt', 'b.txt', 'c.txt'])
        assert(result.uploadedFiles.includes(file), 'uploaded_file')
      assert(result.uploadedBytes > 0, 'uploaded_bytes')
      evidence.uploadedFiles = result.uploadedFiles.length
      evidence.uploadedBytes = result.uploadedBytes
      evidence.ids = identity
    })
    const cat = async (evidence) => {
      const result = await invoke(['exec', '--', 'cat', 'a.txt']).done
      evidence.exitCode = result.code
      checkProcess(result)
      assert.equal(result.stdout, expected, 'remote_file_content')
      evidence.contentSha256 = sha256(result.stdout)
      evidence.ids = identity
    }
    await required('exec-cat', cat)
    await required('exec-sleep-start', async (evidence) => {
      running = invoke(['exec', '--json', '--', 'sleep', '600'])
      const deadline = Date.now() + 30_000
      let record
      while (Date.now() < deadline) {
        record = (await mappings(state)).find(
          (record) => record.localSessionId === identity.sessionId && record.lastExecutionId,
        )
        if (record) break
        assert(running.child.exitCode === null, 'sleep_ended_early')
        await delay(50)
      }
      assert(record?.lastExecutionId, 'execution_ready')
      identity.executionId = safeId(record.lastExecutionId)
      evidence.ids = { ...identity }
      evidence.background = true
    })
    await required('cancel', async (evidence) => {
      const result = await structured(['cancel'], 'execution.cancelled', evidence)
      assert.equal(result?.executionId, identity.executionId, 'cancel_execution')
      assert.equal(result?.state, 'cancelled', 'cancel_state')
      evidence.ids = { ...identity }
    })
    await required('exec-sleep-cancelled', async (evidence) => {
      const result = await running.done
      evidence.exitCode = result.code
      evidence.processDurationMs = result.durationMs
      checkProcess(result, 130)
      assert.equal(JSON.parse(result.stdout)?.outcome, 'cancelled', 'execution_outcome')
      evidence.ids = { ...identity }
    })
    await required('stop', async (evidence) => {
      const view = await structured(['stop'], 'session.stopped', evidence)
      assert.equal(view?.session?.state, 'stopped', 'session_stopped')
      assert.equal(view?.sandbox?.id, identity.sandboxId, 'sandbox_identity')
      evidence.ids = idsOf(view, await mappings(state), hostedProjectId)
    })
    await required('restart', async (evidence) => {
      const view = await structured(['start'], 'session.started', evidence)
      assert.equal(view?.session?.state, 'active', 'session_active')
      assert.equal(view?.session?.id, identity.sessionId, 'session_identity')
      assert.equal(view?.sandbox?.id, identity.sandboxId, 'sandbox_identity')
      const ids = idsOf(view, await mappings(state), hostedProjectId)
      assert.equal(ids.hostedSessionId, identity.hostedSessionId, 'hosted_session_identity')
      assert.equal(ids.hostedSandboxId, identity.hostedSandboxId, 'hosted_sandbox_identity')
      evidence.ids = ids
    })
    await required('exec-cat-after-restart', cat)
  } catch (error) {
    // Failed steps already have safe evidence; cleanup has its own budgets.
    if (steps.every((entry) => entry.pass))
      await step('setup', () => {
        throw error instanceof CheckFailure ? error : new CheckFailure('setup_failed')
      })
  } finally {
    // These are the journey's final two steps, also run after any earlier failure.
    if (cli) {
      const cleanup = await cleanupEligibility(state)
      if (cleanup.destroy)
        await step('destroy', async (evidence) => {
          const view = await structured(['destroy', '--yes'], 'session.destroyed', evidence)
          assert.equal(view?.session?.state, 'destroyed', 'session_destroyed')
          assert.equal(view?.sandbox, null, 'sandbox_removed')
          assert(view.session.sandboxDeletionVerifiedAt, 'deletion_verified')
          evidence.ids = { ...identity }
        })
      else skip('destroy', 'no_session_created')
      if (running) {
        running.child.kill('SIGKILL')
        await running.done
      }
      if (cleanup.logout)
        await step('logout', async (evidence) => {
          const result = await structured(['auth', 'logout'], 'auth.logged_out', evidence)
          assert.equal(result?.loggedOut, true, 'logout_result')
          assert.equal(result?.revoked, true, 'logout_revoked')
          assert(!existsSync(join(state, 'auth.json')), 'auth_metadata_removed')
        })
      else skip('logout', 'not_signed_in')
    } else {
      skip('destroy', 'cli_unavailable')
      skip('logout', 'cli_unavailable')
    }
    await step('cleanup', async () => {
      for (const child of children) child.kill('SIGKILL')
      try {
        if (mock) mock.assertComplete(steps)
      } finally {
        try {
          if (mock) await mock.stop()
          if (registry) await registry.stop()
        } finally {
          await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        }
      }
    })
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
  const requiredNames = [
    'pack-install',
    'login',
    'init',
    'start',
    'sync-push',
    'exec-cat',
    'exec-sleep-start',
    'cancel',
    'exec-sleep-cancelled',
    'stop',
    'restart',
    'exec-cat-after-restart',
    'destroy',
    'logout',
    'cleanup',
  ]
  const missingSteps = requiredNames.filter((name) => !steps.some((entry) => entry.step === name))
  for (const name of missingSteps) {
    const skipped = {
      step: name,
      pass: false,
      skipped: true,
      durationMs: 0,
      exitCode: null,
      ids: {},
      failure: 'not_run',
      reason: 'prior_step_failed',
    }
    steps.push(skipped)
    emit(skipped)
  }
  const pass = !interrupted && missingSteps.length === 0 && steps.every((entry) => entry.pass)
  emit({
    harness: 'accept-installed',
    schemaVersion: 1,
    mode: options.selfTest ? 'self-test' : 'live',
    pass,
    passedSteps: steps.filter((entry) => entry.pass).length,
    totalSteps: steps.length,
    missingSteps,
  })
  return pass ? 0 : 1
}

/** Hosted patterns from test-cli-{auth,lifecycle}.mjs, combined for one journey. */
export async function mockHosted({ loginFault } = {}) {
  const now = new Date().toISOString()
  const requestId = '11111111-1111-4111-8111-111111111111'
  const access = 'mock_access'.padEnd(48, 'a'),
    refresh = 'mock_refresh'.padEnd(48, 'r')
  const magicParameters = {
    challenge: 'opaque challenge +/=',
    userId: 'user',
    secret: 'opaque secret +/=',
    extra: 'opaque extra',
  }
  const csrf = 'mock_csrf'.padEnd(48, 'c')
  const consentId = 'mock_consent'.padEnd(32, 's')
  const codes = new Map(),
    operations = new Map(),
    manifests = new Map(),
    executions = new Map()
  const workspace = new Map()
  const counts = {
    mail: 0,
    consume: 0,
    session: 0,
    authorize: 0,
    token: 0,
    revoke: 0,
    webLogout: 0,
    create: 0,
    stop: 0,
    start: 0,
    destroy: 0,
    deliver: 0,
    cancel: 0,
    cat: 0,
  }
  let project,
    session,
    tag,
    namespace,
    magicConsumed = false,
    consentBinding
  let mock, failure
  const publicManifest = ({ chunks, ...manifest }) => manifest
  mock = await listen(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const path = url.pathname
      const chunks = []
      let bodyBytes = 0
      for await (const chunk of req) {
        bodyBytes += chunk.length
        assert(bodyBytes <= limits.body)
        chunks.push(chunk)
      }
      const raw = Buffer.concat(chunks).toString()
      const body = raw ? JSON.parse(raw) : undefined
      const send = (value, status = 200, headers = {}) =>
        res
          .writeHead(status, {
            'content-type': 'application/json',
            'x-request-id': requestId,
            ...headers,
          })
          .end(value === undefined ? undefined : JSON.stringify(value))
      const absent = () =>
        send({ error: { code: 'NOT_FOUND', message: 'Missing' }, requestId }, 404)
      if (path === '/v1/auth/magic-links') {
        assert.equal(req.headers.origin, mock.origin)
        assert.equal(req.method, 'POST')
        assert.equal(++counts.mail, 1, 'one_email_only')
        const [address] = body.email.split('@')
        ;[namespace, tag] = address.split('.')
        return send({ accepted: true }, 200, {
          ...(loginFault === 'missing_binding'
            ? {}
            : {
                'set-cookie': 'ocb_login_bind=mock_binding; HttpOnly; SameSite=Lax; Path=/',
              }),
        })
      }
      if (path === '/api/json') {
        assert.equal(url.searchParams.get('apikey'), 'mock-key')
        assert.equal(url.searchParams.get('namespace'), namespace)
        assert.equal(url.searchParams.get('tag'), tag)
        return send({
          result: 'success',
          emails: [
            {
              tag,
              timestamp: Date.now(),
              text: `Sign in: ${mock.origin}/v1/auth/browser/magic-links/consume?${new URLSearchParams(
                loginFault === 'missing_parameters'
                  ? { challenge: magicParameters.challenge }
                  : magicParameters,
              )}`,
            },
          ],
        })
      }
      if (path === '/v1/auth/browser/magic-links/consume') {
        assert.equal(req.method, 'GET', 'consume_method')
        assert.equal(req.headers.accept, 'text/html', 'consume_accept')
        assert.equal(req.headers['content-type'], undefined, 'consume_body')
        assert.equal(body, undefined, 'consume_body')
        assert(
          req.headers.cookie.includes('ocb_login_bind=mock_binding'),
          'binding_cookie_required',
        )
        assert.deepEqual(
          Object.fromEntries(url.searchParams),
          magicParameters,
          'consume_parameters',
        )
        assert(!magicConsumed, 'single_use_link')
        magicConsumed = true
        counts.consume++
        return res
          .writeHead(loginFault === 'consume_status' ? 200 : 303, {
            location:
              loginFault === 'consume_redirect'
                ? 'https://foreign.example.test/'
                : `${mock.origin}/signed-in`,
            'set-cookie': [
              'ocb_login_bind=; Max-Age=0; Path=/',
              ...(loginFault === 'missing_session'
                ? []
                : ['ocb_session=mock_web; HttpOnly; SameSite=Lax; Path=/']),
              ...(loginFault === 'missing_csrf'
                ? []
                : [`browser_csrf=${csrf}; SameSite=Lax; Path=/`]),
            ],
          })
          .end()
      }
      if (path === '/v1/auth/cli/authorize') {
        assert.equal(req.headers.origin, mock.origin)
        assert(req.headers.cookie.includes('ocb_session=mock_web'))
        assert.equal(req.headers['x-csrf-token'], csrf)
        assert.equal(body.codeChallengeMethod, 'S256')
        assert.equal(body.audience, 'cli')
        assert.equal(body.clientId, 'ocb_cli')
        assert.equal(body.scope, scopes.join(' '))
        counts.authorize++
        if (loginFault === 'authorize_status') return send({}, 403)
        if (!body.consent) {
          consentBinding = body
          return send({
            status: 'consent_required',
            consentId,
            clientId: body.clientId,
            audience: body.audience,
            scopes: loginFault === 'widened_consent' ? [...scopes, 'mcp:execute'] : scopes,
          })
        }
        const { consent, ...binding } = body
        assert.deepEqual(binding, consentBinding)
        assert.deepEqual(consent, { consentId, approve: true })
        const code = 'mock_code'.padEnd(48, 'k')
        codes.set(code, binding)
        const redirect = new URL(body.redirectUri)
        redirect.searchParams.set('code', code)
        redirect.searchParams.set(
          'state',
          loginFault === 'callback_state' ? 'different' : body.state,
        )
        if (loginFault === 'callback_duplicate') redirect.searchParams.append('state', body.state)
        if (loginFault === 'callback_path') redirect.pathname = '/other'
        if (loginFault === 'callback_origin') redirect.port = '1'
        return send({ status: 'authorized', redirectUri: redirect.href, expiresAt: now })
      }
      if (path === '/v1/auth/sessions/current') {
        assert(req.headers.cookie.includes('ocb_session=mock_web'), 'session_cookie_required')
        if (loginFault !== 'missing_csrf')
          assert(req.headers.cookie.includes(`browser_csrf=${csrf}`), 'csrf_cookie_required')
        if (req.method === 'GET') {
          counts.session++
          return send(
            {
              id: 'web_session',
              userId: 'user',
              createdAt: now,
              expiresAt: now,
              authMethod: 'magic_link',
            },
            200,
            { 'x-csrf-token': csrf },
          )
        }
        assert.equal(req.method, 'DELETE')
        if (req.headers['x-csrf-token'] !== csrf)
          return send({ error: { code: 'CSRF_TOKEN_INVALID' } }, 403)
        assert(req.headers.cookie.includes('ocb_session=mock_web'))
        counts.webLogout++
        return send(undefined, 204)
      }
      if (path === '/v1/auth/cli/token') {
        assert.equal(body.grantType, 'authorization_code')
        const binding = codes.get(body.code)
        assert(binding)
        assert.equal(
          createHash('sha256').update(body.codeVerifier, 'ascii').digest('base64url'),
          binding.codeChallenge,
        )
        assert.equal(body.redirectUri, binding.redirectUri)
        assert.equal(body.clientId, binding.clientId)
        codes.delete(body.code)
        counts.token++
        return send({
          accessToken: access,
          refreshToken: refresh,
          tokenType: 'Bearer',
          expiresIn: 900,
          scope: scopes.join(' '),
        })
      }
      if (path === '/v1/auth/revoke') {
        assert([access, refresh].includes(body.token))
        counts.revoke++
        return send(undefined, 204)
      }
      assert.equal(req.headers.authorization, `Bearer ${access}`, 'bearer_required')
      if (path === '/v1/projects' && req.method === 'GET')
        return send({ data: project ? [project] : [], nextCursor: null })
      if (path === '/v1/projects' && req.method === 'POST') {
        assert.equal(project, undefined)
        assert.equal(typeof req.headers['idempotency-key'], 'string')
        project = { id: 'hosted_project', name: body.name, createdAt: now, updatedAt: now }
        return send(project, 201)
      }
      if (path === '/v1/projects/hosted_project') {
        assert(project)
        return send(project)
      }
      if (path === '/v1/projects/hosted_project/sessions') {
        assert(project)
        assert.equal(req.method, 'POST')
        assert.equal(++counts.create, 1)
        session = {
          id: 'hosted_session',
          projectId: project.id,
          createdAt: now,
          updatedAt: now,
          requestedSpec: {},
          effectiveSpec: {},
          normalizedState: 'running',
          rawState: 'running',
          primarySandboxId: 'hosted_sandbox',
          sandboxes: [
            {
              ordinal: 0,
              role: 'primary',
              active: true,
              state: 'running',
              sandboxId: 'hosted_sandbox',
              boundAt: now,
              releasedAt: null,
            },
          ],
        }
        return operation('create')
      }
      if (path.startsWith('/v1/operations/')) return send(operations.get(path.split('/').at(-1)))
      if (path === '/v1/sessions/hosted_session/source/manifests') {
        assert(session && session.normalizedState === 'running')
        if (req.method === 'GET')
          return send({ data: [...manifests.values()].map(publicManifest), nextCursor: null })
        assert.equal(req.method, 'POST')
        assert.equal(typeof req.headers['idempotency-key'], 'string')
        const manifest = {
          ...body,
          id: `source_${manifests.size}`,
          sessionId: session.id,
          createdAt: now,
          updatedAt: now,
          verified: false,
          uploadedChunks: 0,
          chunks: new Map(),
        }
        manifests.set(manifest.id, manifest)
        return send(publicManifest(manifest), 201)
      }
      const source = /^\/v1\/source\/manifests\/([^/]+)\/(?:chunks\/(\d+)|(checksum))$/.exec(path)
      if (source) {
        const [, id, index, checksum] = source
        const manifest = manifests.get(id)
        assert(manifest)
        assert.equal(typeof req.headers['idempotency-key'], 'string')
        if (!checksum) {
          assert.equal(req.method, 'PUT')
          const bytes = Buffer.from(body.data, 'base64')
          assert.equal(sha256(bytes), body.checksum)
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
        assert.equal(req.method, 'POST')
        assert.equal(manifest.chunks.size, manifest.chunkCount)
        const archive = Buffer.concat(
          Array.from({ length: manifest.chunkCount }, (_, i) => manifest.chunks.get(i)),
        )
        assert.equal(archive.length, manifest.totalBytes)
        assert.equal(sha256(archive), manifest.checksum)
        assert.equal(archive.subarray(0, 8).toString(), 'OCBOXA1\n')
        const entries = []
        let offset = 8
        for (;;) {
          const length = archive.readUInt32BE(offset)
          offset += 4
          const header = JSON.parse(archive.subarray(offset, offset + length).toString())
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
          entries.push(entry)
          if (entry.type !== 'directory') {
            const bytes = archive.subarray(offset, offset + entry.size)
            offset += entry.size
            assert.equal(sha256(bytes), entry.sha256)
            workspace.set(entry.path, bytes.toString())
          }
        }
        for (const file of ['a.txt', 'b.txt', 'c.txt']) assert(workspace.has(file))
        assert.equal(workspace.get('a.txt'), expected)
        manifest.verified = true
        counts.deliver++
        return send({
          manifestId: id,
          checksum: manifest.checksum,
          chunkCount: manifest.chunkCount,
          verified: true,
        })
      }
      const matched = /^\/v1\/sessions\/hosted_session(?:\/(.*))?$/.exec(path)
      if (matched) {
        if (!session) return absent()
        const action = matched[1]
        if (!action) return send(session)
        if (action === 'executions') {
          assert.equal(session.normalizedState, 'running')
          assert.equal(req.method, 'POST')
          assert(["'cat' 'a.txt'", "'sleep' '600'"].includes(body.command))
          const long = body.command === "'sleep' '600'"
          const id = `execution_${executions.size}`
          if (!long) counts.cat++
          executions.set(id, {
            id,
            command: body.command,
            long,
            cancelled: false,
            stdout: long ? '' : workspace.get('a.txt'),
          })
          assert(long || workspace.has('a.txt'))
          return send(
            { id, createdAt: now, sessionId: session.id, sandboxId: session.primarySandboxId },
            202,
          )
        }
        assert(['stop', 'start', 'destroy'].includes(action))
        assert.equal(req.method, 'POST')
        counts[action]++
        if (action === 'destroy') session = undefined
        else {
          session.sandboxes[0].state = action === 'stop' ? 'stopped' : 'running'
          session.normalizedState = session.sandboxes[0].state
        }
        return operation(action)
      }
      const execution = /^\/v1\/executions\/([^/]+)(?:\/(.*))?$/.exec(path)
      if (execution) {
        const [, id, action] = execution
        const record = executions.get(id)
        assert(record)
        if (action === 'cancel') {
          assert(record.long)
          record.cancelled = true
          counts.cancel++
          return send({ id: 'cancel_operation' }, 202)
        }
        if (!action)
          return send({
            id,
            createdAt: now,
            updatedAt: now,
            sessionId: 'hosted_session',
            sandboxId: 'hosted_sandbox',
            state: record.cancelled ? 'cancelled' : record.long ? 'running' : 'completed',
            command: record.command,
            exitCode: null,
            failureKind: null,
            failure: null,
            truncated: false,
            outputBytes: 0,
            outputLimitBytes: 1024,
          })
        if (action === 'events') {
          const data =
            record.long && !record.cancelled
              ? []
              : [
                  ...(record.stdout
                    ? [
                        {
                          sequence: 0,
                          at: now,
                          kind: 'stdout',
                          stream: 'stdout',
                          message: record.stdout,
                        },
                      ]
                    : []),
                  {
                    sequence: record.stdout ? 1 : 0,
                    at: now,
                    kind: record.cancelled ? 'cancelled' : 'completed',
                    stream: null,
                    message: '',
                  },
                ]
          return send({ data, nextCursor: null })
        }
        if (action === 'result')
          return send(
            record.cancelled
              ? { kind: 'cancelled' }
              : {
                  kind: 'command',
                  exitCode: 0,
                  stdout: record.stdout,
                  stderr: '',
                  truncated: false,
                  outputBytes: 0,
                  outputLimitBytes: 1024,
                },
          )
      }
      return absent()
      function operation(action) {
        const op = {
          id: `operation_${operations.size}`,
          kind: `session_${action}`,
          createdAt: now,
          updatedAt: now,
          projectId: project.id,
          sessionId: 'hosted_session',
          state: 'succeeded',
          progress: 100,
          requestId,
          error: null,
          resource: null,
        }
        operations.set(op.id, op)
        return send(op, 202)
      }
    } catch (error) {
      failure = error
      throw error
    }
  })
  return {
    ...mock,
    counts,
    assertComplete(steps) {
      assert(!failure, 'mock_contract')
      if (steps.some((step) => !step.pass)) return
      for (const name of [
        'mail',
        'consume',
        'session',
        'token',
        'webLogout',
        'create',
        'stop',
        'start',
        'destroy',
        'deliver',
        'cancel',
      ])
        assert.equal(counts[name], 1, `mock_${name}`)
      assert.equal(counts.cat, 2)
      assert.equal(counts.authorize, 2)
      assert(counts.revoke > 0)
      assert.equal(session, undefined)
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch(() => {
      process.stderr.write(
        'Usage: node scripts/accept-installed.mjs --self-test | --api-url <origin> [--verbose]\n',
      )
      process.exitCode = 1
    })
}

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(repositoryRoot, 'dist', 'index.js')
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' }

const root = await mkdtemp(join(tmpdir(), 'ocbox-auth-e2e-'))
const stateRoot = join(root, 'state')
const platformRoot = join(root, 'platform')
const children = new Set()

function s256(verifier) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

function tokenPair(counter) {
  return {
    accessToken: `access_${counter}`.padEnd(48, 'a'),
    expiresIn: 900,
    refreshToken: `refresh_${counter}`.padEnd(48, 'r'),
    scope: 'source:read',
    tokenType: 'Bearer',
  }
}

/** Cross-platform environment so credentials/metadata stay inside the temp root. */
function isolatedEnvironment() {
  if (process.platform === 'win32') {
    return { APPDATA: platformRoot, LOCALAPPDATA: platformRoot }
  }
  if (process.platform === 'darwin') return { HOME: platformRoot }
  return { HOME: platformRoot, XDG_CONFIG_HOME: platformRoot, XDG_STATE_HOME: platformRoot }
}

function credentialDirectory() {
  if (process.platform === 'win32') return join(platformRoot, 'OpenCloudBox', 'Credentials')
  if (process.platform === 'darwin') {
    return join(platformRoot, 'Library', 'Application Support', 'OpenCloudBox', 'Credentials')
  }
  return join(platformRoot, 'ocbox', 'credentials')
}

function hasCredentialFile() {
  const directory = credentialDirectory()
  if (!existsSync(directory)) return false
  return readdirSync(directory).some((name) => name.endsWith('.json'))
}

/** Mock hosted auth server: token exchange, rotation, and revocation. */
function startMockAuthApi() {
  const codes = new Map()
  const refreshTokens = new Set()
  const calls = { exchange: 0, refresh: 0, revoke: 0, revoked: [] }
  let counter = 0
  let lastPair = null
  let revokeFails = false
  let exchangeFails = false

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'POST') {
      response.writeHead(405, jsonHeaders).end('{}')
      return
    }
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        response
          .writeHead(400, jsonHeaders)
          .end(JSON.stringify({ error: { code: 'INVALID_REQUEST' } }))
        return
      }
      if (url.pathname === '/v1/auth/cli/token') {
        if (body.grantType === 'authorization_code') {
          calls.exchange += 1
          const record = codes.get(body.code)
          const valid =
            !exchangeFails &&
            record !== undefined &&
            record.challenge === s256(body.codeVerifier) &&
            record.redirectUri === body.redirectUri
          if (!valid) {
            response
              .writeHead(400, jsonHeaders)
              .end(JSON.stringify({ error: { code: 'INVALID_GRANT' } }))
            return
          }
          codes.delete(body.code)
          counter += 1
          const pair = tokenPair(counter)
          lastPair = pair
          refreshTokens.add(pair.refreshToken)
          response.writeHead(200, jsonHeaders).end(JSON.stringify(pair))
          return
        }
        if (body.grantType === 'refresh_token') {
          calls.refresh += 1
          if (!refreshTokens.has(body.refreshToken)) {
            response
              .writeHead(400, jsonHeaders)
              .end(JSON.stringify({ error: { code: 'INVALID_GRANT' } }))
            return
          }
          refreshTokens.delete(body.refreshToken)
          counter += 1
          const pair = tokenPair(counter)
          lastPair = pair
          refreshTokens.add(pair.refreshToken)
          response.writeHead(200, jsonHeaders).end(JSON.stringify(pair))
          return
        }
      }
      if (url.pathname === '/v1/auth/revoke') {
        calls.revoke += 1
        calls.revoked.push(body.token)
        if (revokeFails) {
          response
            .writeHead(500, jsonHeaders)
            .end(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }))
          return
        }
        refreshTokens.delete(body.token)
        response.writeHead(204).end()
        return
      }
      response.writeHead(404, jsonHeaders).end(JSON.stringify({ error: { code: 'NOT_FOUND' } }))
    })
  })

  return new Promise((resolvePromise) => {
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      resolvePromise({
        calls,
        issueCode(code, challenge, redirectUri) {
          codes.set(code, { challenge, redirectUri })
        },
        lastPair: () => lastPair,
        setExchangeFails(value) {
          exchangeFails = value
        },
        setRevokeFails(value) {
          revokeFails = value
        },
        stop: () =>
          new Promise((done) => {
            server.close(() => done())
            server.closeIdleConnections()
          }),
        url: `http://127.0.0.1:${address.port}`,
      })
    })
  })
}

function sendCallback(redirectUri, code, state) {
  const url = new URL(redirectUri)
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest(
      {
        host: url.hostname,
        method: 'GET',
        path: `/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
        port: Number(url.port),
      },
      (response) => {
        response.resume()
        response.on('end', () => resolvePromise())
      },
    )
    request.on('error', rejectPromise)
    request.end()
  })
}

/** Incrementally extracts complete JSON envelopes from a stream buffer. */
function extractJsonValues(buffer) {
  const values = []
  let index = 0
  while (index < buffer.length) {
    while (index < buffer.length && /\s/.test(buffer[index])) index += 1
    if (index >= buffer.length) break
    if (buffer[index] !== '{' && buffer[index] !== '[') {
      const newline = buffer.indexOf('\n', index)
      if (newline < 0) break
      index = newline + 1
      continue
    }
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let cursor = index; cursor < buffer.length; cursor += 1) {
      const character = buffer[cursor]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') inString = true
      else if (character === '{' || character === '[') depth += 1
      else if (character === '}' || character === ']') {
        depth -= 1
        if (depth === 0) {
          end = cursor
          break
        }
      }
    }
    if (end < 0) break
    try {
      values.push(JSON.parse(buffer.slice(index, end + 1)))
    } catch {
      // Ignore incomplete or non-envelope content.
    }
    index = end + 1
  }
  return { rest: buffer.slice(index), values }
}

/**
 * Runs the built CLI, streaming envelopes. `onEvent` lets the harness complete
 * the loopback callback as soon as the manual authorization URL is printed.
 */
function run(args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd ?? root,
      env: { NO_COLOR: '1', ...isolatedEnvironment(), ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    children.add(child)
    const stdout = []
    const stderr = []
    const events = []
    let buffer = ''
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
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk)
      buffer += chunk.toString('utf8')
      const extracted = extractJsonValues(buffer)
      buffer = extracted.rest
      for (const envelope of extracted.values) {
        events.push(envelope)
        options.onEvent?.(envelope)
      }
    })
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => finish(() => rejectPromise(error)))
    child.on('close', (code, signal) =>
      finish(() =>
        resolvePromise({
          code,
          events,
          signal,
          stderr: Buffer.concat(stderr),
          stdout: Buffer.concat(stdout),
        }),
      ),
    )
  })
}

function parseResultEnvelope(result, name) {
  const envelopes = result.events.filter((envelope) => envelope.kind === 'result')
  assert.equal(envelopes.length, 1, 'stdout must contain exactly one result envelope')
  const envelope = envelopes[0]
  assert.equal(envelope.schemaVersion, 1)
  if (name !== undefined) assert.equal(envelope.name, name)
  return envelope
}

function assertPurity(result, secrets) {
  const output = `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`
  for (const secret of secrets) {
    assert.equal(
      output.includes(secret),
      false,
      `secret material leaked into CLI output: ${secret}`,
    )
  }
}

let mock
try {
  mock = await startMockAuthApi()

  // 1. Successful manual-open login completed by a mock-loopback callback.
  let loginCode
  const login = await run(
    ['auth', 'login', '--api-url', mock.url, '--no-browser', '--json', '--state-dir', stateRoot],
    {
      onEvent: (envelope) => {
        if (envelope.kind !== 'event' || envelope.name !== 'auth.authorization_url') return
        const authorizationUrl = new URL(envelope.data.url)
        assert.equal(authorizationUrl.searchParams.get('response_type'), 'code')
        assert.equal(authorizationUrl.searchParams.get('audience'), 'cli')
        assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256')
        const redirectUri = authorizationUrl.searchParams.get('redirect_uri')
        const state = authorizationUrl.searchParams.get('state')
        const challenge = authorizationUrl.searchParams.get('code_challenge')
        loginCode = `mocked_code_${Date.now()}`
        mock.issueCode(loginCode, challenge, redirectUri)
        void sendCallback(redirectUri, loginCode, state).catch(() => undefined)
      },
    },
  )
  assert.equal(login.code, 0, login.stderr.toString('utf8'))
  const loginResult = parseResultEnvelope(login, 'auth.logged_in')
  assert.equal(loginResult.data.loggedIn, true)
  assert.equal(loginResult.data.browserOpened, false)
  assert.equal(loginResult.data.issuer, mock.url)
  assert.equal(loginResult.data.audience, 'cli')
  assert.deepEqual(loginResult.data.scopes, ['source:read'])
  assert.equal(mock.calls.exchange, 1)
  const issued = mock.lastPair()
  assertPurity(login, [loginCode, issued.accessToken, issued.refreshToken])
  assert.equal(existsSync(join(stateRoot, 'auth.json')), true)
  assert.equal(hasCredentialFile(), true)
  const metadataText = readFileSync(join(stateRoot, 'auth.json'), 'utf8')
  assert.equal(metadataText.includes('access_'), false)
  assert.equal(metadataText.includes('refresh_'), false)

  // 2. Status reports facts only.
  const status = await run(['auth', 'status', '--json', '--state-dir', stateRoot])
  assert.equal(status.code, 0)
  const statusResult = parseResultEnvelope(status, 'auth.status')
  assert.equal(statusResult.data.loggedIn, true)
  assert.deepEqual(statusResult.data.scopes, ['source:read'])
  assertPurity(status, [issued.accessToken, issued.refreshToken])

  // 3. No out-of-band/pasted-code fallback exists.
  const help = await run(['auth', 'login', '--help'])
  const helpText = help.stdout.toString('utf8').toLowerCase()
  assert.equal(helpText.includes('out-of-band'), false)
  assert.equal(helpText.includes('paste'), false)

  // 4. Logout revokes and clears local material.
  const logout = await run(['auth', 'logout', '--json', '--state-dir', stateRoot])
  assert.equal(logout.code, 0)
  const logoutResult = parseResultEnvelope(logout, 'auth.logged_out')
  assert.deepEqual(logoutResult.data, {
    loggedOut: true,
    revocationAttempted: true,
    revoked: true,
  })
  assert.equal(mock.calls.revoke, 1)
  assert.equal(hasCredentialFile(), false)
  assert.equal(existsSync(join(stateRoot, 'auth.json')), false)
  const loggedOutStatus = await run(['auth', 'status', '--json', '--state-dir', stateRoot])
  assert.equal(parseResultEnvelope(loggedOutStatus, 'auth.status').data.loggedIn, false)

  // 5. Revocation failure still clears local material.
  const secondLogin = await run(
    ['auth', 'login', '--api-url', mock.url, '--no-browser', '--json', '--state-dir', stateRoot],
    {
      onEvent: (envelope) => {
        if (envelope.kind !== 'event' || envelope.name !== 'auth.authorization_url') return
        const authorizationUrl = new URL(envelope.data.url)
        const redirectUri = authorizationUrl.searchParams.get('redirect_uri')
        const state = authorizationUrl.searchParams.get('state')
        const challenge = authorizationUrl.searchParams.get('code_challenge')
        const code = `mocked_code_fail_${Date.now()}`
        mock.issueCode(code, challenge, redirectUri)
        void sendCallback(redirectUri, code, state).catch(() => undefined)
      },
    },
  )
  assert.equal(secondLogin.code, 0, secondLogin.stderr.toString('utf8'))
  mock.setRevokeFails(true)
  const failedLogout = await run(['auth', 'logout', '--json', '--state-dir', stateRoot])
  assert.equal(failedLogout.code, 0)
  const failedResult = parseResultEnvelope(failedLogout, 'auth.logged_out')
  assert.equal(failedResult.data.loggedOut, true)
  assert.equal(failedResult.data.revocationAttempted, true)
  assert.equal(failedResult.data.revoked, false)
  assert.equal(hasCredentialFile(), false)
  assert.equal(existsSync(join(stateRoot, 'auth.json')), false)

  console.log('CLI auth smoke passed (login, manual-open fallback, status, logout, revoke failure)')
} finally {
  for (const child of children) child.kill('SIGKILL')
  if (mock !== undefined) await mock.stop()
  try {
    // Windows can briefly hold ACL-protected credential files open; retry.
    rmSync(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
  } catch {
    // The temp root is outside the repository; leaving it is safer than failing.
  }
}

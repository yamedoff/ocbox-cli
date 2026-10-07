import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { resolve, sep } from 'node:path'
import { test } from 'node:test'
import {
  browserLogin,
  parseArgs,
  privateEnvironment,
  redact,
  validateAuthorization,
} from './accept-installed.mjs'

const scopes = ['source:read', 'product:read', 'product:edit', 'product:run']
function authorization(origin) {
  const url = new URL('/v1/auth/cli/authorize', origin)
  const params = {
    response_type: 'code',
    client_id: 'ocb_cli',
    audience: 'cli',
    redirect_uri: 'http://127.0.0.1:23456/callback',
    state: 's'.repeat(32),
    code_challenge: 'c'.repeat(43),
    code_challenge_method: 'S256',
    scope: scopes.join(' '),
  }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url
}

test('mode and origin validation refuses ambiguous runs and credential-bearing targets', () => {
  for (const args of [
    [],
    ['--self-test', '--api-url', 'https://api.example'],
    ['--api-url'],
    ['--api-url', 'https://user:secret@api.example'],
    ['--api-url', 'https://api.example/subpath'],
    ['--self-test', '--unexpected'],
  ]) {
    assert.throws(() => parseArgs(args))
  }
  assert.deepEqual(parseArgs(['--api-url', 'https://api.example/']), {
    selfTest: false,
    apiUrl: 'https://api.example',
  })
})

test('child isolation excludes operator credentials and runtime overrides', () => {
  const previous = { ...process.env }
  try {
    Object.assign(process.env, {
      TESTMAIL_API_KEY: 'private',
      OCBOX_TOKEN_URL: 'https://foreign.example',
      OCBOX_PROJECT_ID: 'foreign-project',
      NODE_OPTIONS: '--require=foreign',
      NPM_TOKEN: 'private',
      HTTP_PROXY: 'https://foreign.example',
    })
    const root = resolve('private-root')
    const env = privateEnvironment(root)
    for (const name of [
      'TESTMAIL_API_KEY',
      'OCBOX_TOKEN_URL',
      'OCBOX_PROJECT_ID',
      'NODE_OPTIONS',
      'NPM_TOKEN',
      'HTTP_PROXY',
    ])
      assert.equal(env[name], undefined)
    for (const name of [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_STATE_HOME',
      'APPDATA',
      'LOCALAPPDATA',
      'NPM_CONFIG_CACHE',
    ])
      assert(env[name].startsWith(`${root}${sep}`))
  } finally {
    process.env = previous
  }
})

test('evidence redaction covers nested mail addresses, URL proofs and bearer material', () => {
  const data = {
    nested: [
      'person@example.test',
      'Bearer private-value',
      'https://example.test/?token=private-token&code=private-code&state=private-state&code_challenge=private-challenge',
      'eyJabcdefghijklmnop.qwerty.signature',
    ],
  }
  const output = JSON.stringify(redact(data))
  for (const secret of [
    'person@',
    'private-value',
    'private-token',
    'private-code',
    'private-state',
    'private-challenge',
    'eyJabc',
  ])
    assert(!output.includes(secret))
})

test('authorization binding rejects foreign callbacks, duplicate parameters and scope changes', () => {
  const origin = 'http://127.0.0.1:54321'
  validateAuthorization(authorization(origin).href, origin)
  for (const mutate of [
    (url) => url.searchParams.set('redirect_uri', 'http://localhost:23456/callback'),
    (url) => url.searchParams.append('state', 'x'.repeat(32)),
    (url) => url.searchParams.set('scope', [...scopes, 'mcp:execute'].join(' ')),
    (url) => {
      url.username = 'credential'
    },
  ]) {
    const url = authorization(origin)
    mutate(url)
    assert.throws(() => validateAuthorization(url.href, origin))
  }
})

for (const boundary of ['foreign redirect', 'widened consent']) {
  test(`browser driver rejects ${boundary} and still revokes its web session`, async () => {
    const token = 't'.repeat(48),
      csrf = 'c'.repeat(48)
    let tag,
      logout = 0,
      consent = 0
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, origin)
        const parts = []
        for await (const part of request) parts.push(part)
        const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : undefined
        const send = (value, status = 200, headers = {}) =>
          response
            .writeHead(status, { 'content-type': 'application/json', ...headers })
            .end(JSON.stringify(value))
        if (url.pathname === '/v1/auth/magic-links') {
          tag = body.email.split('@')[0].split('.')[1]
          return send({ accepted: true }, 200, { 'set-cookie': 'ocb_login_bind=binding; HttpOnly' })
        }
        if (url.pathname === '/api/json') {
          assert.equal(url.searchParams.get('apikey'), 'private-mail-key')
          return send({
            result: 'success',
            emails: [
              {
                tag,
                timestamp: Date.now(),
                html: `<a href="${origin}/login?token=${token}&amp;next=home">Login</a>`,
              },
            ],
          })
        }
        assert.equal(request.headers.origin, origin)
        if (url.pathname === '/v1/auth/magic-links/consume') {
          assert.equal(body.token, token)
          assert(request.headers.cookie.includes('ocb_login_bind=binding'))
          return send({ csrfToken: csrf }, 200, { 'set-cookie': 'ocb_session=session; HttpOnly' })
        }
        assert.equal(request.headers['x-csrf-token'], csrf)
        assert(request.headers.cookie.includes('ocb_session=session'))
        if (url.pathname === '/v1/auth/cli/authorize') {
          consent++
          if (!body.consent)
            return send({
              status: 'consent_required',
              consentId: 'id'.repeat(16),
              scopes: boundary === 'widened consent' ? [...scopes, 'mcp:execute'] : scopes,
            })
          return send({
            status: 'authorized',
            redirectUri: `http://127.0.0.1:1/callback?code=private-code&state=${body.state}`,
          })
        }
        assert.equal(url.pathname, '/v1/auth/sessions/current')
        assert.equal(request.method, 'DELETE')
        logout++
        return response.writeHead(204).end()
      } catch {
        response.writeHead(500).end('{}')
      }
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    const origin = `http://127.0.0.1:${server.address().port}`
    try {
      await assert.rejects(
        browserLogin(authorization(origin).href, {
          apiOrigin: origin,
          webOrigin: origin,
          key: 'private-mail-key',
          namespace: 'mail',
          mailboxOrigin: origin,
        }),
      )
      assert.equal(logout, 1)
      assert.equal(consent, boundary === 'foreign redirect' ? 2 : 1)
    } finally {
      await new Promise((done) => {
        server.close(done)
        server.closeAllConnections()
      })
    }
  })
}

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { resolve, sep } from 'node:path'
import { test } from 'node:test'
import {
  browserLogin,
  cleanupEligibility,
  failureEvidence,
  findMagicLink,
  mockHosted,
  safeHttpPath,
  createMailboxAdapter,
  parseArgs,
  privateEnvironment,
  redact,
  validateAuthorization,
  validateCallback,
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
    verbose: false,
  })
  assert.equal(parseArgs(['--self-test', '--verbose']).verbose, true)
  assert.throws(() => parseArgs(['--self-test', '--verbose', '--verbose']))
})

test('child isolation excludes operator credentials and runtime overrides', () => {
  const previous = { ...process.env }
  try {
    Object.assign(process.env, {
      OCB_TEST_MAILBOX_API_KEY: 'private',
      OCB_TEST_MAILBOX_NAMESPACE: 'private',
      OCB_TEST_MAILBOX_API_URL: 'https://mailbox.example.test',
      OCB_TEST_MAILBOX_DOMAIN: 'inbox.example.test',
      OCBOX_TOKEN_URL: 'https://foreign.example',
      OCBOX_PROJECT_ID: 'foreign-project',
      NODE_OPTIONS: '--require=foreign',
      NPM_TOKEN: 'private',
      HTTP_PROXY: 'https://foreign.example',
    })
    const root = resolve('private-root')
    const env = privateEnvironment(root)
    for (const name of [
      'OCB_TEST_MAILBOX_API_KEY',
      'OCB_TEST_MAILBOX_NAMESPACE',
      'OCB_TEST_MAILBOX_API_URL',
      'OCB_TEST_MAILBOX_DOMAIN',
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
      'https://example.test/?token=private-token&code=private-code&state=private-state&code_challenge=private-challenge&challenge=private-proof&userId=private-user&secret=private-secret',
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
    'private-proof',
    'private-user',
    'private-secret',
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

const callbackBinding = {
  redirectUri: 'http://127.0.0.1:23456/callback',
  state: 's'.repeat(32),
  apiOrigin: 'https://api.example.test',
}
function callbackUrl() {
  const url = new URL(callbackBinding.redirectUri)
  url.searchParams.set('code', 'c'.repeat(48))
  url.searchParams.set('state', callbackBinding.state)
  url.searchParams.set('iss', callbackBinding.apiOrigin)
  return url
}

test('callback accepts a same-origin issuer URL or no issuer and preserves the URL', () => {
  for (const issuer of [callbackBinding.apiOrigin, `${callbackBinding.apiOrigin}/issuer/`, null]) {
    const url = callbackUrl()
    if (issuer === null) url.searchParams.delete('iss')
    else url.searchParams.set('iss', issuer)
    const raw = url.href.replace('code=c', 'code=%63')
    assert.equal(validateCallback(raw, callbackBinding).href, raw)
  }
})

for (const [name, mutate, check, unexpectedParameterCount] of [
  [
    'foreign origin',
    (url) => {
      url.hostname = 'localhost'
    },
    'callback_origin',
  ],
  [
    'wrong port',
    (url) => {
      url.port = '1'
    },
    'callback_origin',
  ],
  [
    'wrong scheme',
    (url) => {
      url.protocol = 'https:'
    },
    'callback_origin',
  ],
  [
    'credentials',
    (url) => {
      url.username = 'private-user'
      url.password = 'private-value'
    },
    'callback_origin',
  ],
  [
    'wrong path',
    (url) => {
      url.pathname = '/other'
    },
    'callback_path',
  ],
  [
    'fragment',
    (url) => {
      url.hash = '#private-value'
    },
    'callback_path',
  ],
  ['missing state', (url) => url.searchParams.delete('state'), 'callback_state'],
  ['empty state', (url) => url.searchParams.set('state', ''), 'callback_state'],
  ['wrong state', (url) => url.searchParams.set('state', 'private-value'), 'callback_state'],
  ['missing code', (url) => url.searchParams.delete('code'), 'callback_code'],
  ['empty code', (url) => url.searchParams.set('code', ''), 'callback_code'],
  [
    'duplicate code',
    (url) => url.searchParams.append('code', 'private-value'),
    'callback_parameters',
    1,
  ],
  [
    'duplicate state',
    (url) => url.searchParams.append('state', callbackBinding.state),
    'callback_parameters',
    1,
  ],
  [
    'duplicate issuer',
    (url) => url.searchParams.append('iss', callbackBinding.apiOrigin),
    'callback_parameters',
    1,
  ],
  [
    'unknown parameter',
    (url) => url.searchParams.append('private-name', 'private-value'),
    'callback_parameters',
    1,
  ],
  [
    'multiple unexpected parameters',
    (url) => {
      url.searchParams.append('private-name', 'private-value')
      url.searchParams.append('private-name', 'private-value')
      url.searchParams.append('state', callbackBinding.state)
    },
    'callback_parameters',
    3,
  ],
]) {
  test(`callback rejects ${name} with specific, bounded evidence`, () => {
    const url = callbackUrl()
    mutate(url)
    assert.throws(
      () => validateCallback(url.href, callbackBinding),
      (error) => {
        assert.deepEqual(failureEvidence(error), {
          failure: 'assertion_failed',
          check,
          ...(unexpectedParameterCount === undefined ? {} : { unexpectedParameterCount }),
        })
        assert(!JSON.stringify(failureEvidence(error)).includes('private'))
        return true
      },
    )
  })
}

for (const issuer of [
  '',
  'invalid',
  '/issuer',
  'https://foreign.example.test',
  'http://api.example.test',
  'https://api.example.test:444',
  'https://private-user:private-value@api.example.test',
  'https://api.example.test?private-name=private-value',
  'https://api.example.test#private-value',
  'file:///issuer',
]) {
  test('callback rejects an unsafe or mismatched issuer without exposing it', () => {
    const url = callbackUrl()
    url.searchParams.set('iss', issuer)
    assert.throws(
      () => validateCallback(url.href, callbackBinding),
      (error) => {
        assert.deepEqual(failureEvidence(error), {
          failure: 'assertion_failed',
          check: 'callback_issuer',
        })
        return true
      },
    )
  })
}

test('HTTP issuer is accepted only for the explicitly enabled local mock', () => {
  const url = callbackUrl()
  const binding = { ...callbackBinding, apiOrigin: 'http://127.0.0.1:54321' }
  url.searchParams.set('iss', binding.apiOrigin)
  assert.throws(
    () => validateCallback(url.href, binding),
    (error) => failureEvidence(error).check === 'callback_issuer',
  )
  assert.equal(validateCallback(url.href, { ...binding, allowMockHttp: true }).href, url.href)
  const remoteBinding = {
    ...callbackBinding,
    apiOrigin: 'http://api.example.test',
    allowMockHttp: true,
  }
  url.searchParams.set('iss', remoteBinding.apiOrigin)
  assert.throws(
    () => validateCallback(url.href, remoteBinding),
    (error) => failureEvidence(error).check === 'callback_issuer',
  )
  assert.throws(
    () => validateCallback('http://[invalid', callbackBinding),
    (error) => failureEvidence(error).check === 'callback_origin',
  )
})

test('mailbox adapter uses the configured base URL and domain and filters unrelated or old messages', async () => {
  let status = 200
  let result = 'success'
  const server = createServer((request, response) => {
    const url = new URL(request.url, origin)
    assert.equal(url.pathname, '/mailbox/api/json')
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      apikey: 'private-mail-key',
      namespace: 'fixture',
      tag: 'current',
      timestamp_from: '100',
      livequery: 'false',
    })
    response.writeHead(status, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        result,
        emails: [
          { tag: 'other', timestamp: 101, text: 'unrelated' },
          { tag: 'current', timestamp: 99, text: 'old' },
          { tag: 'current', text: 'missing timestamp' },
          { tag: 'current', timestamp: 100, text: 'plain', html: '<p>html</p>' },
        ],
      }),
    )
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  const config = {
    apiUrl: `${origin}/mailbox`,
    key: 'private-mail-key',
    namespace: 'fixture',
    domain: 'inbox.example.test',
  }
  try {
    const mailbox = createMailboxAdapter(config)
    assert.equal(mailbox.address('current'), 'fixture.current@inbox.example.test')
    assert.deepEqual(await mailbox.messages({ tag: 'current', since: 100 }), ['plain\n<p>html</p>'])
    status = 503
    await assert.rejects(mailbox.messages({ tag: 'current', since: 100 }), /mailbox_http_status/)
    status = 200
    result = 'failure'
    await assert.rejects(mailbox.messages({ tag: 'current', since: 100 }), /mailbox_result/)
    for (const change of [
      { apiUrl: undefined },
      { apiUrl: 'https://user:private@mailbox.example.test' },
      { apiUrl: 'file:///mailbox' },
      { domain: undefined },
      { domain: 'invalid@domain' },
      { key: '' },
      { namespace: 'invalid@namespace' },
    ])
      assert.throws(() => createMailboxAdapter({ ...config, ...change }))
  } finally {
    await new Promise((done) => {
      server.close(done)
      server.closeAllConnections()
    })
  }
})

const failures = {
  missing_binding: ['binding_cookie_missing', 200, 0],
  missing_parameters: ['magic_link_not_found', undefined, 0],
  consume_status: ['consume_status', 200, 0, 'web'],
  consume_redirect: ['consume_redirect', 303, 0, 'other'],
  missing_session: ['session_cookie_missing', 303, 0, 'web'],
  missing_csrf: ['csrf_missing', 200, 0],
  missing_csrf_echo: ['csrf_missing', 200, 0],
  authorize_status: ['authorize_status', 403, 1],
  widened_consent: ['consent_scopes', undefined, 1],
  callback_origin: ['callback_origin', undefined, 2],
  callback_path: ['callback_path', undefined, 2],
  callback_state: ['callback_state', undefined, 2],
  callback_code: ['callback_code', undefined, 2],
  callback_issuer: ['callback_issuer', undefined, 2],
  callback_duplicate: ['callback_parameters', undefined, 2, undefined, 1],
  callback_duplicate_issuer: ['callback_parameters', undefined, 2, undefined, 1],
  callback_parameters: ['callback_parameters', undefined, 2, undefined, 1],
}

for (const [
  fault,
  [label, status, authorizeCount, redirectOrigin, unexpectedParameterCount],
] of Object.entries(failures)) {
  test(`browser self-test rejects ${fault} with safe evidence`, async () => {
    const mock = await mockHosted({ loginFault: fault })
    const traces = []
    try {
      await assert.rejects(
        browserLogin(authorization(mock.origin).href, {
          apiOrigin: mock.origin,
          webOrigin: mock.webOrigin,
          allowMockHttp: true,
          mailbox: createMailboxAdapter({
            apiUrl: mock.origin,
            key: 'mock-key',
            namespace: 'mock',
            domain: 'mailbox.example.test',
            onTrace: (event) => traces.push(event),
          }),
          mailboxTimeoutMs: 20,
          pollIntervalMs: 1,
          onTrace: (event) => traces.push(event),
        }),
        (error) => {
          assert.deepEqual(failureEvidence(error), {
            failure: 'assertion_failed',
            check: label,
            ...(status === undefined ? {} : { httpStatus: status }),
            ...(redirectOrigin === undefined ? {} : { redirectOrigin }),
            ...(unexpectedParameterCount === undefined ? {} : { unexpectedParameterCount }),
          })
          return true
        },
      )
      assert.equal(mock.counts.authorize, authorizeCount)
      assert.equal(
        mock.counts.webLogout,
        [
          'missing_binding',
          'missing_parameters',
          'missing_session',
          'missing_csrf',
          'missing_csrf_echo',
        ].includes(fault)
          ? 0
          : 1,
      )
      mock.assertComplete([{ pass: false }])
      for (const event of traces) {
        assert(!event.path.includes('?'))
        assert(Number.isInteger(event.durationMs))
        assert(/^(GET|POST|DELETE)$/.test(event.method))
      }
      const output = JSON.stringify(traces)
      for (const secret of [
        'mock-key',
        'opaque',
        'mock_web',
        'mock_binding',
        'mock_csrf',
        'private-parameter',
        'private-value',
        '@',
      ])
        assert(!output.includes(secret))
    } finally {
      await mock.stop()
    }
  })
}

for (const [name, options] of [
  ['web-origin redirect with issuer', {}],
  ['callback without issuer', { includeIssuer: false }],
  ['API-origin redirect', { consumeOrigin: 'api' }],
  ['relative API-origin redirect', { consumeLocation: '/signed-in' }],
  ['CSRF cookie rotation', { rotateCsrf: true }],
]) {
  test(`browser self-test accepts ${name} and confirms the session before consent`, async () => {
    let callbackRequests = 0
    const callbackServer = createServer((request, response) => {
      callbackRequests++
      const expected = new URL('/callback', 'http://localhost')
      expected.searchParams.set('code', 'mock_code'.padEnd(48, 'k'))
      expected.searchParams.set('state', 's'.repeat(32))
      if (options.includeIssuer !== false) expected.searchParams.set('iss', mock.origin)
      assert.equal(request.url, `${expected.pathname}${expected.search}`)
      response.writeHead(200).end('signed in')
    })
    await new Promise((done) => callbackServer.listen(0, '127.0.0.1', done))
    const mock = await mockHosted(options)
    try {
      const url = authorization(mock.origin)
      url.searchParams.set(
        'redirect_uri',
        `http://127.0.0.1:${callbackServer.address().port}/callback`,
      )
      const traces = []
      await browserLogin(url.href, {
        apiOrigin: mock.origin,
        webOrigin: mock.webOrigin,
        allowMockHttp: true,
        mailbox: createMailboxAdapter({
          apiUrl: mock.origin,
          key: 'mock-key',
          namespace: 'mock',
          domain: 'mailbox.example.test',
        }),
        onTrace: (event) => traces.push(event),
      })
      assert.equal(callbackRequests, 1)
      assert.equal(mock.counts.consume, 1)
      assert.equal(mock.counts.session, 1)
      assert.equal(mock.counts.authorize, 2)
      assert.equal(mock.counts.webLogout, 1)
      assert.equal(mock.counts.webNavigation, 0)
      assert.deepEqual(
        traces.map(({ method, path, status }) => [method, path, status]),
        [
          ['POST', '/v1/auth/magic-links', 200],
          ['GET', '/v1/auth/browser/magic-links/consume', 303],
          ['GET', '/v1/auth/sessions/current', 200],
          ['POST', '/v1/auth/cli/authorize', 200],
          ['POST', '/v1/auth/cli/authorize', 200],
          ['GET', '/callback', 200],
          ['DELETE', '/v1/auth/sessions/current', 204],
        ],
      )
      mock.assertComplete([{ pass: false }])
    } finally {
      await mock.stop()
      await new Promise((done) => {
        callbackServer.close(done)
        callbackServer.closeAllConnections()
      })
    }
  })
}

for (const [name, consumeLocation, redirectOrigin] of [
  ['foreign origin', 'https://foreign.example.test/private?token=private-token', 'other'],
  ['wrong scheme', ({ webOrigin }) => webOrigin.replace('http:', 'https:'), 'other'],
  [
    'wrong port',
    ({ webOrigin }) => {
      const url = new URL(webOrigin)
      url.port = '1'
      return url.href
    },
    'other',
  ],
  ['web credentials', ({ webOrigin }) => webOrigin.replace('//', '//user:private@'), 'web'],
  ['API credentials', ({ apiOrigin }) => apiOrigin.replace('//', '//user:private@'), 'api'],
  ['fragment', ({ webOrigin }) => `${webOrigin}/signed-in#private`, 'web'],
  ['missing location', null, 'missing'],
  ['empty location', '', 'missing'],
  ['malformed location', 'http://[invalid', 'other'],
]) {
  test(`browser self-test rejects redirect with ${name} without exposing the URL`, async () => {
    const mock = await mockHosted({ consumeLocation })
    try {
      await assert.rejects(
        browserLogin(authorization(mock.origin).href, {
          apiOrigin: mock.origin,
          webOrigin: mock.webOrigin,
          mailbox: createMailboxAdapter({
            apiUrl: mock.origin,
            key: 'mock-key',
            namespace: 'mock',
            domain: 'mailbox.example.test',
          }),
        }),
        (error) => {
          assert.deepEqual(failureEvidence(error), {
            failure: 'assertion_failed',
            check: 'consume_redirect',
            httpStatus: 303,
            redirectOrigin,
          })
          return true
        },
      )
      assert.equal(mock.counts.authorize, 0)
      assert.equal(mock.counts.webLogout, 1)
      mock.assertComplete([{ pass: false }])
    } finally {
      await mock.stop()
    }
  })
}

test('mock revocation requires the web Origin, session and CSRF cookies, and matching CSRF header', async () => {
  const mock = await mockHosted()
  try {
    const issued = await fetch(`${mock.origin}/v1/auth/magic-links`, {
      method: 'POST',
      headers: { origin: mock.webOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mock.current@mailbox.example.test' }),
    })
    assert.equal(issued.status, 200)
    const mailbox = createMailboxAdapter({
      apiUrl: mock.origin,
      key: 'mock-key',
      namespace: 'mock',
      domain: 'mailbox.example.test',
    })
    const link = findMagicLink(await mailbox.messages({ tag: 'current', since: 0 }), mock.origin)
    const consumed = await fetch(link, {
      redirect: 'manual',
      headers: { accept: 'text/html', cookie: issued.headers.getSetCookie()[0].split(';')[0] },
    })
    assert.equal(consumed.status, 303)
    const cookies = consumed.headers
      .getSetCookie()
      .slice(1)
      .map((cookie) => cookie.split(';')[0])
    for (const cookie of [cookies[0], `${cookies[0]}; browser_csrf=wrong`]) {
      const session = await fetch(`${mock.origin}/v1/auth/sessions/current`, {
        headers: { origin: mock.webOrigin, cookie },
      })
      assert.equal(session.status, 200)
      assert.equal(session.headers.get('x-ocb-csrf-token'), null)
      assert.equal(session.headers.get('x-csrf-token'), null)
      await session.arrayBuffer()
    }
    const session = await fetch(`${mock.origin}/v1/auth/sessions/current`, {
      headers: { origin: mock.webOrigin, cookie: cookies.join('; ') },
    })
    assert.equal(session.status, 200)
    assert.equal(session.headers.get('x-ocb-csrf-token'), cookies[1].split('=')[1])
    assert.equal(session.headers.get('x-csrf-token'), null)
    const headers = {
      origin: mock.webOrigin,
      cookie: cookies.join('; '),
      'x-csrf-token': session.headers.get('x-ocb-csrf-token'),
    }
    for (const change of [
      { origin: undefined },
      { origin: mock.origin },
      { origin: 'https://foreign.example.test' },
      { cookie: undefined },
      { cookie: cookies[0] },
      { cookie: cookies[1] },
      { 'x-csrf-token': undefined },
      { 'x-csrf-token': 'wrong' },
    ]) {
      const response = await fetch(`${mock.origin}/v1/auth/sessions/current`, {
        method: 'DELETE',
        headers: Object.fromEntries(
          Object.entries({ ...headers, ...change }).filter(([, value]) => value !== undefined),
        ),
      })
      assert.equal(response.status, 403)
      await response.arrayBuffer()
    }
    const revoked = await fetch(`${mock.origin}/v1/auth/sessions/current`, {
      method: 'DELETE',
      headers,
    })
    assert.equal(revoked.status, 204)
    assert.equal(mock.counts.webLogout, 1)
    mock.assertComplete([{ pass: false }])
  } finally {
    await mock.stop()
  }
})

test('link selection preserves opaque values and additional parameters while rejecting unsafe links', () => {
  const origin = 'https://api.example.test'
  const link = new URL('/v1/auth/browser/magic-links/consume', origin)
  for (const [key, value] of Object.entries({
    challenge: 'space + /=',
    userId: 'opaque user',
    secret: 'secret + /=',
    extra: 'unknown',
  }))
    link.searchParams.set(key, value)
  assert.equal(
    findMagicLink([`<a href="${link.href.replaceAll('&', '&amp;')}">Sign in</a>`], origin).href,
    link.href,
  )
  for (const mutate of [
    (url) => {
      url.hostname = 'foreign.example.test'
    },
    (url) => {
      url.pathname = '/other'
    },
    (url) => {
      url.username = 'private'
    },
    (url) => {
      url.hash = '#private'
    },
    (url) => url.searchParams.delete('secret'),
    (url) => url.searchParams.set('secret', ''),
    (url) => url.searchParams.append('challenge', 'duplicate'),
  ]) {
    const invalid = new URL(link)
    mutate(invalid)
    assert.equal(findMagicLink([invalid.href], origin), undefined)
  }
  assert.equal(
    safeHttpPath('/v1/sessions/private-value/executions/private-execution'),
    '/v1/sessions/:id/executions/:id',
  )
  assert.deepEqual(failureEvidence(new Error('private-message')), { failure: 'operation_failed' })
})

test('an empty test mailbox produces a deadline label', async () => {
  const mock = await mockHosted()
  try {
    await assert.rejects(
      browserLogin(authorization(mock.origin).href, {
        apiOrigin: mock.origin,
        webOrigin: mock.webOrigin,
        mailbox: { address: () => 'mock.current@mailbox.example.test', messages: async () => [] },
        mailboxTimeoutMs: 10,
        pollIntervalMs: 1,
      }),
      (error) => failureEvidence(error).check === 'mailbox_deadline',
    )
  } finally {
    await mock.stop()
  }
})

test('cleanup applies only to persisted hosted sessions and CLI sign-in', async () => {
  const state = await mkdtemp(join(tmpdir(), 'accept-cleanup-'))
  try {
    assert.deepEqual(await cleanupEligibility(state), { destroy: false, logout: false })
    await writeFile(join(state, 'auth.json'), '{}')
    assert.deepEqual(await cleanupEligibility(state), { destroy: false, logout: true })
    await mkdir(join(state, 'project'))
    await writeFile(
      join(state, 'project', 'state.json'),
      JSON.stringify({
        hostedMappings: {
          hosted: { local: { hostedSessionId: 'session' } },
        },
      }),
    )
    assert.deepEqual(await cleanupEligibility(state), { destroy: true, logout: true })
  } finally {
    await rm(state, { recursive: true, force: true })
  }
})

test('failed installed login preserves its label and skips inapplicable cleanup', {
  timeout: 180_000,
}, async () => {
  const result = await new Promise((done) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { main } from './scripts/accept-installed.mjs'; process.exitCode = await main(['--self-test', '--verbose'], { loginFault: 'missing_binding' })",
      ],
      { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => done({ code, stdout, stderr }))
  })
  assert.equal(result.code, 1)
  const evidence = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(evidence.find((entry) => entry.step === 'login').check, 'binding_cookie_missing')
  for (const [step, reason] of [
    ['destroy', 'no_session_created'],
    ['logout', 'not_signed_in'],
  ]) {
    const entry = evidence.find((entry) => entry.step === step)
    assert.equal(entry.skipped, true)
    assert.equal(entry.reason, reason)
    assert.equal(entry.failure, undefined)
    assert.equal(entry.cliErrorCode, undefined)
  }
  const traces = result.stderr
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .filter((event) => event.substep === 'http')
  assert(
    traces.some(
      (event) =>
        event.method === 'POST' && event.path === '/v1/auth/magic-links' && event.status === 200,
    ),
  )
  for (const secret of [
    'mock-key',
    'mock_binding',
    'mock_web',
    'mock_csrf',
    '@',
    '?',
    'http://',
    'https://',
  ])
    assert(!JSON.stringify(traces).includes(secret))
})

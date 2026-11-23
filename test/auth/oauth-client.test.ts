import { describe, expect, it } from 'vitest'
import { CliOAuthClient, withRedirectDisabled } from '../../src/auth/oauth-client.js'
import type { FetchPort } from '../../src/auth/ports.js'
import { OcboxError } from '../../src/errors/index.js'

const VALID_PAIR = {
  accessToken: 'a'.repeat(48),
  expiresIn: 900,
  refreshToken: 'r'.repeat(48),
  scope: 'source:read',
  tokenType: 'Bearer' as const,
}

function clientWith(fetchImpl: FetchPort, timeoutMilliseconds = 1_000): CliOAuthClient {
  return new CliOAuthClient({
    apiBase: 'https://api.test',
    clientId: 'ocb_cli',
    fetch: fetchImpl,
    revocationEndpoint: 'https://api.test/auth/revoke',
    timeoutMilliseconds,
    tokenEndpoint: 'https://api.test/auth/cli/token',
  })
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  })
}

const EXCHANGE = {
  code: 'c'.repeat(40),
  codeVerifier: 'v'.repeat(43),
  redirectUri: 'http://127.0.0.1:49152/callback',
}

describe('CLI OAuth client', () => {
  it('validates and returns the documented token pair', async () => {
    const client = clientWith(() => Promise.resolve(json(VALID_PAIR)))
    await expect(client.exchangeAuthorizationCode(EXCHANGE)).resolves.toEqual(VALID_PAIR)
  })

  it('rejects a malformed token response without echoing it', async () => {
    const client = clientWith(() => Promise.resolve(json({ ...VALID_PAIR, accessToken: 'short' })))
    const error = await client.exchangeAuthorizationCode(EXCHANGE).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(OcboxError)
    expect((error as OcboxError).code).toBe('PROVIDER_AUTH')
    expect(JSON.stringify(error)).not.toContain(VALID_PAIR.accessToken)
  })

  it('maps invalid grant to a typed login-required error', async () => {
    const client = clientWith(() =>
      Promise.resolve(
        json({ error: { code: 'INVALID_GRANT' } }, 400, { 'x-request-id': 'req_srv' }),
      ),
    )
    const error = await client
      .refresh({ refreshToken: 'r'.repeat(48) })
      .catch((value: unknown) => value)
    expect(error).toBeInstanceOf(OcboxError)
    expect((error as OcboxError).code).toBe('AUTH_REQUIRED')
    expect((error as OcboxError).providerCode).toBe('INVALID_GRANT')
    // biome-ignore lint/complexity/useLiteralKeys: redacted details are an index signature
    expect((error as OcboxError).details?.['providerRequestId']).toBe('req_srv')
  })

  it('surfaces Retry-After on rate limiting', async () => {
    const client = clientWith(() =>
      Promise.resolve(json({ error: { code: 'RATE_LIMITED' } }, 429, { 'retry-after': '12' })),
    )
    const error = await client.exchangeAuthorizationCode(EXCHANGE).catch((value: unknown) => value)
    expect((error as OcboxError).code).toBe('PROVIDER_RATE_LIMIT')
    // biome-ignore lint/complexity/useLiteralKeys: redacted details are an index signature
    expect((error as OcboxError).details?.['retryAfterSeconds']).toBe(12)
  })

  it('maps service-unavailable responses', async () => {
    const client = clientWith(() => Promise.resolve(json({}, 503)))
    await expect(client.exchangeAuthorizationCode(EXCHANGE)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    })
  })

  it('enforces a bounded timeout on hanging requests', async () => {
    const hanging: FetchPort = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    const client = clientWith(hanging, 20)
    await expect(client.exchangeAuthorizationCode(EXCHANGE)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    })
  })

  it('enforces timeout and cancellation while a response body is still streaming', async () => {
    const bodyThatNeverEnds = (): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Intentionally produce neither a chunk nor EOF.
          },
        }),
      )
    const timeoutClient = clientWith(() => Promise.resolve(bodyThatNeverEnds()), 20)
    await expect(timeoutClient.exchangeAuthorizationCode(EXCHANGE)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    })

    const controller = new AbortController()
    const cancellingClient = clientWith(() => Promise.resolve(bodyThatNeverEnds()), 10_000)
    const pending = cancellingClient.exchangeAuthorizationCode({
      ...EXCHANGE,
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
  })

  it('binds both credential-bearing endpoints to one configured API base', () => {
    expect(
      () =>
        new CliOAuthClient({
          apiBase: 'https://api.test/deploy',
          clientId: 'ocb_cli',
          fetch: () => Promise.reject(new Error('must not run')),
          revocationEndpoint: 'https://api.test/deploy/v1/auth/revoke',
          timeoutMilliseconds: 1_000,
          tokenEndpoint: 'https://api.test/other/v1/auth/cli/token',
        }),
    ).toThrow(/configured hosted API base/)
  })

  it('refuses a token response whose body exceeds the bounded read size instead of buffering it', async () => {
    // A 1 MB stream is far above the 256 KiB read ceiling and the 64 KiB parse cap.
    const oversized = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let chunk = 0; chunk < 64; chunk += 1) {
            controller.enqueue(new Uint8Array(16 * 1024).fill(0x61))
          }
          controller.close()
        },
      }),
      { status: 200 },
    )
    const client = clientWith(() => Promise.resolve(oversized))
    const error = await client.exchangeAuthorizationCode(EXCHANGE).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(OcboxError)
    expect((error as OcboxError).code).toBe('PROVIDER_AUTH')
    expect(JSON.stringify(error)).not.toContain('aaaaaaaa')
  })

  it('still maps non-ok responses whose body exceeds the bounded read size without echoing it', async () => {
    const oversizedError = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let chunk = 0; chunk < 64; chunk += 1) {
            controller.enqueue(new Uint8Array(16 * 1024).fill(0x62))
          }
          controller.close()
        },
      }),
      { status: 503 },
    )
    const client = clientWith(() => Promise.resolve(oversizedError))
    const error = await client.revoke({ token: 'r'.repeat(48) }).catch((value: unknown) => value)
    expect((error as OcboxError).code).toBe('PROVIDER_UNAVAILABLE')
    expect(JSON.stringify(error)).not.toContain('bbbbbbbb')
  })

  it('never sends a client secret in the public-client grant', async () => {
    let captured = ''
    const client = clientWith((_input, init) => {
      captured = String(init?.body ?? '')
      return Promise.resolve(json(VALID_PAIR))
    })
    await client.exchangeAuthorizationCode(EXCHANGE)
    expect(captured.toLowerCase()).not.toContain('secret')
    expect(captured).toContain('"grantType":"authorization_code"')
  })

  it('revokes successfully and reports failures', async () => {
    const client = clientWith(() => Promise.resolve(new Response(null, { status: 204 })))
    await expect(client.revoke({ token: 'r'.repeat(48) })).resolves.toBeUndefined()

    const failing = clientWith(() => Promise.resolve(json({}, 500)))
    await expect(failing.revoke({ token: 'r'.repeat(48) })).rejects.toBeInstanceOf(OcboxError)
  })

  it('never lets fetch follow redirects on protocol requests', async () => {
    const redirects: Array<unknown> = []
    const client = clientWith((_input, init) => {
      redirects.push(init?.redirect)
      return Promise.resolve(json(VALID_PAIR))
    })
    await client.exchangeAuthorizationCode(EXCHANGE)
    await client.revoke({ token: 'r'.repeat(48) })
    expect(redirects).toEqual(['manual', 'manual'])
  })

  it('rejects scope values outside the pinned contract alphabet', async () => {
    const client = clientWith(() =>
      Promise.resolve(
        json({
          ...VALID_PAIR,
          scope: encodeURIComponent('SOURCE:read;cd $(whoami)'),
        }),
      ),
    )
    const error = await client.exchangeAuthorizationCode(EXCHANGE).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(OcboxError)
    expect((error as OcboxError).code).toBe('PROVIDER_AUTH')
  })

  it('refuses an oversized revocation response body instead of reporting success', async () => {
    const oversizedOk = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let chunk = 0; chunk < 8; chunk += 1) {
            controller.enqueue(new Uint8Array(16 * 1024).fill(0x63))
          }
          controller.close()
        },
      }),
      { status: 200 },
    )
    const client = clientWith(() => Promise.resolve(oversizedOk))
    await expect(client.revoke({ token: 'r'.repeat(48) })).rejects.toMatchObject({
      code: 'PROVIDER_AUTH',
    })
  })

  it('forces manual redirects even when the init tries to override them', () => {
    expect(withRedirectDisabled({ redirect: 'follow' }).redirect).toBe('manual')
    expect(withRedirectDisabled({ redirect: 'error', method: 'POST' })).toMatchObject({
      method: 'POST',
      redirect: 'manual',
    })
  })

  it('reports caller cancellation distinctly from a transport timeout', async () => {
    const hanging: FetchPort = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => reject(new Error('aborted'))
        if (init?.signal?.aborted) onAbort()
        else init?.signal?.addEventListener('abort', onAbort, { once: true })
      })
    const controller = new AbortController()
    const client = clientWith(hanging, 10_000)
    const pending = client.exchangeAuthorizationCode({
      ...EXCHANGE,
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    await expect(pending).rejects.not.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })

    let called = false
    const alreadyCancelled = new AbortController()
    alreadyCancelled.abort()
    const ignoring = clientWith(() => {
      called = true
      return Promise.resolve(json(VALID_PAIR))
    })
    await expect(
      ignoring.exchangeAuthorizationCode({ ...EXCHANGE, signal: alreadyCancelled.signal }),
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    expect(called).toBe(false)
  })

  it('rejects a successful revocation body beyond the wire ceiling instead of silently succeeding', async () => {
    const oversizedOk = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          // 384 KiB, well above both the 64 KiB protocol ceiling and the old
          // 256 KiB read shield that previously reset the body to empty.
          for (let chunk = 0; chunk < 24; chunk += 1) {
            controller.enqueue(new Uint8Array(16 * 1024).fill(0x64))
          }
          controller.close()
        },
      }),
      { status: 200 },
    )
    const client = clientWith(() => Promise.resolve(oversizedOk))
    const error = await client.revoke({ token: 'r'.repeat(48) }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(OcboxError)
    expect((error as OcboxError).code).toBe('PROVIDER_AUTH')
    expect(JSON.stringify(error)).not.toContain('dddddddd')
  })

  it('bounds multibyte success bodies by bytes, not UTF-16 length', async () => {
    // 20,000 four-byte code points: 80,000 UTF-8 bytes but only 40,000 UTF-16
    // code units, so a `text.length` check would wrongly accept it.
    const body = '\u{1F600}'.repeat(20_000)
    expect(body.length).toBeLessThan(64 * 1024)
    const client = clientWith(() => Promise.resolve(new Response(body, { status: 200 })))
    await expect(client.revoke({ token: 'r'.repeat(48) })).rejects.toMatchObject({
      code: 'PROVIDER_AUTH',
    })
  })
})

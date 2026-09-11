import { describe, expect, it } from 'vitest'
import { CliOAuthClient } from '../../src/auth/oauth-client.js'
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
    expect((error as OcboxError).details?.['providerRequestId']).toBe('req_srv')
  })

  it('surfaces Retry-After on rate limiting', async () => {
    const client = clientWith(() =>
      Promise.resolve(json({ error: { code: 'RATE_LIMITED' } }, 429, { 'retry-after': '12' })),
    )
    const error = await client.exchangeAuthorizationCode(EXCHANGE).catch((value: unknown) => value)
    expect((error as OcboxError).code).toBe('PROVIDER_RATE_LIMIT')
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
    const client = clientWith((input, init) =>
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
})

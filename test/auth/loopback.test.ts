import { request as httpRequest } from 'node:http'
import { describe, expect, it } from 'vitest'
import { type LoopbackListener, startLoopbackListener } from '../../src/auth/loopback.js'
import { OcboxError } from '../../src/errors/index.js'

const STATE = 'state-value-1234567890'
// Codes match the pinned contract boundary (32-256 base64url characters).
const LONG_CODE = 'c'.repeat(40)
const OTHER_LONG_CODE = 'd'.repeat(40)

interface SentResponse {
  readonly status: number
  readonly body: string
}

function send(
  redirectUri: string,
  options: { method?: string; path?: string; host?: string } = {},
): Promise<SentResponse> {
  const url = new URL(redirectUri)
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: { host: options.host ?? `${url.hostname}:${url.port}` },
        host: url.hostname,
        method: options.method ?? 'GET',
        path: options.path ?? `${url.pathname}${url.search}`,
        port: Number(url.port),
        setHost: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            status: response.statusCode ?? 0,
          }),
        )
      },
    )
    request.on('error', reject)
    request.end()
  })
}

async function withListener(
  run: (listener: LoopbackListener) => Promise<void>,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  const listener = await startLoopbackListener({
    expectedState: STATE,
    timeoutMilliseconds,
  })
  try {
    await run(listener)
  } finally {
    await listener.close()
  }
}

describe('loopback callback listener', () => {
  it('binds only to 127.0.0.1 and accepts exactly one callback', async () => {
    await withListener(async (listener) => {
      expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
      const pending = listener.waitForCallback()
      const accepted = await send(`${listener.redirectUri}?code=${LONG_CODE}&state=${STATE}`)
      expect(accepted.status).toBe(200)
      expect(accepted.body).not.toContain(LONG_CODE)
      await expect(pending).resolves.toEqual({ code: LONG_CODE })

      const duplicate = await send(`${listener.redirectUri}?code=${LONG_CODE}&state=${STATE}`)
      expect(duplicate.status).toBe(409)
    })
  })

  it('rejects wrong method, path, and host without settling the pending callback', async () => {
    await withListener(async (listener) => {
      const pending = listener.waitForCallback()
      const method = await send(listener.redirectUri, { method: 'POST' })
      expect(method.status).toBe(405)
      const path = await send(listener.redirectUri, {
        path: `/other?code=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx&state=${STATE}`,
      })
      expect(path.status).toBe(404)
      const host = await send(
        `${listener.redirectUri}?code=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx&state=${STATE}`,
        {
          host: 'localhost',
        },
      )
      expect(host.status).toBe(400)

      const accepted = await send(`${listener.redirectUri}?code=${LONG_CODE}&state=${STATE}`)
      expect(accepted.status).toBe(200)
      await expect(pending).resolves.toEqual({ code: LONG_CODE })
    })
  })

  it('rejects missing and wrong state, then still accepts the correct callback', async () => {
    await withListener(async (listener) => {
      const pending = listener.waitForCallback()
      expect((await send(`${listener.redirectUri}?code=abc`)).status).toBe(400)
      expect((await send(`${listener.redirectUri}?code=&state=wrong-state`)).status).toBe(400)
      const accepted = await send(`${listener.redirectUri}?code=${LONG_CODE}&state=${STATE}`)
      expect(accepted.status).toBe(200)
      await expect(pending).resolves.toEqual({ code: LONG_CODE })
    })
  })

  it('rejects malformed code values', async () => {
    await withListener(async (listener) => {
      const pending = listener.waitForCallback()
      expect((await send(`${listener.redirectUri}?code=bad%20code&state=${STATE}`)).status).toBe(
        400,
      )
      // Encoded slashes decode outside the base64url alphabet.
      expect(
        (await send(`${listener.redirectUri}?code=${'%2F'.repeat(32)}&state=${STATE}`)).status,
      ).toBe(400)
      const accepted = await send(`${listener.redirectUri}?code=${'f'.repeat(32)}&state=${STATE}`)
      expect(accepted.status).toBe(200)
      await expect(pending).resolves.toEqual({ code: 'f'.repeat(32) })
    })
  })

  it('converts a provider error callback into a typed login-required failure', async () => {
    await withListener(async (listener) => {
      const rejection = expect(listener.waitForCallback()).rejects.toMatchObject({
        code: 'AUTH_REQUIRED',
      })
      const response = await send(`${listener.redirectUri}?error=access_denied&state=${STATE}`)
      expect(response.status).toBe(200)
      await rejection
    })
  })

  it('times out and releases the ephemeral port', async () => {
    await withListener(async (listener) => {
      const rejection = expect(listener.waitForCallback()).rejects.toBeInstanceOf(OcboxError)
      await rejection
      await expect(send(listener.redirectUri)).rejects.toBeTruthy()
    }, 40)
  })

  it('cancels on close and releases the port', async () => {
    const listener = await startLoopbackListener({
      expectedState: STATE,
      timeoutMilliseconds: 5_000,
    })
    const rejection = expect(listener.waitForCallback()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    })
    const redirectUri = listener.redirectUri
    await listener.close()
    await rejection
    await expect(send(redirectUri)).rejects.toBeTruthy()
  })

  it('refuses ambiguous duplicate code, state, and error parameters', async () => {
    await withListener(async (listener) => {
      const pending = listener.waitForCallback()
      expect(
        (
          await send(
            `${listener.redirectUri}?code=${LONG_CODE}&code=${OTHER_LONG_CODE}&state=${STATE}`,
          )
        ).status,
      ).toBe(400)
      expect(
        (await send(`${listener.redirectUri}?code=${LONG_CODE}&state=${STATE}&state=${STATE}`))
          .status,
      ).toBe(400)
      expect(
        (
          await send(
            `${listener.redirectUri}?error=access_denied&error=server_error&state=${STATE}`,
          )
        ).status,
      ).toBe(400)
      expect(
        (
          await send(
            `${listener.redirectUri}?iss=https%3A%2F%2Fx.test&iss=https%3A%2F%2Fy.test&state=${STATE}`,
          )
        ).status,
      ).toBe(400)
      // The refusal does not settle the listener; one clean callback still wins.
      const accepted = await send(`${listener.redirectUri}?code=${LONG_CODE}&state=${STATE}`)
      expect(accepted.status).toBe(200)
      await expect(pending).resolves.toEqual({ code: LONG_CODE })
    })
  })

  it('refuses a mutually ambiguous callback carrying both code and error', async () => {
    await withListener(async (listener) => {
      const pending = listener.waitForCallback()
      const ambiguous = await send(
        `${listener.redirectUri}?code=${LONG_CODE}&error=access_denied&state=${STATE}`,
      )
      expect(ambiguous.status).toBe(400)
      expect((await send(`${listener.redirectUri}?code=${LONG_CODE}&state=${STATE}`)).status).toBe(
        200,
      )
      await expect(pending).resolves.toEqual({ code: LONG_CODE })
    })
  })

  it('refuses duplicated security-adjacent parameters', async () => {
    await withListener(async (listener) => {
      const pending = listener.waitForCallback()
      expect(
        (
          await send(
            `${listener.redirectUri}?code=${LONG_CODE}&state=${STATE}&client_id=ocb_cli&client_id=other`,
          )
        ).status,
      ).toBe(400)
      expect(
        (await send(`${listener.redirectUri}?code=${LONG_CODE}&state=${STATE}&iss=a&iss=b`)).status,
      ).toBe(400)
      const accepted = await send(`${listener.redirectUri}?code=${LONG_CODE}&state=${STATE}`)
      expect(accepted.status).toBe(200)
      await expect(pending).resolves.toEqual({ code: LONG_CODE })
    })
  })

  it('closes the listener under an aborted wait and releases the port', async () => {
    const listener = await startLoopbackListener({
      expectedState: STATE,
      timeoutMilliseconds: 5_000,
    })
    const controller = new AbortController()
    const pending = listener.waitForCallback(controller.signal)
    const redirectUri = listener.redirectUri
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    await listener.close()
    await expect(send(redirectUri)).rejects.toBeTruthy()
  })

  it('rejects an already-aborted wait immediately', async () => {
    const listener = await startLoopbackListener({
      expectedState: STATE,
      timeoutMilliseconds: 5_000,
    })
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(listener.waitForCallback(controller.signal)).rejects.toMatchObject({
        code: 'AUTH_REQUIRED',
      })
    } finally {
      await listener.close()
    }
  })

  it('refuses authorization codes shorter than the pinned contract minimum', async () => {
    await withListener(async (listener) => {
      const pending = listener.waitForCallback()
      expect((await send(`${listener.redirectUri}?code=short&state=${STATE}`)).status).toBe(400)
      expect(
        (await send(`${listener.redirectUri}?code=${'e'.repeat(31)}&state=${STATE}`)).status,
      ).toBe(400)
      const accepted = await send(`${listener.redirectUri}?code=${'e'.repeat(32)}&state=${STATE}`)
      expect(accepted.status).toBe(200)
      await expect(pending).resolves.toEqual({ code: 'e'.repeat(32) })
    })
  })
})

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CliOAuthClient } from '../../src/auth/oauth-client.js'
import { SERVER_AUTH_REASONS } from '../../src/auth/server-reasons.js'
import { recordLocalAuthFailure } from '../../src/auth/diagnostics.js'
import { newRequestId } from '../../src/auth/errors.js'
import { OcboxError } from '../../src/errors/index.js'

describe('safe sign-in failure reporting', () => {
  it.each(Object.keys(SERVER_AUTH_REASONS))(
    'maps %s without displaying server input',
    async (reasonCode) => {
      const client = new CliOAuthClient({
        apiBase: 'https://api.opencloudbox.dev',
        tokenEndpoint: 'https://api.opencloudbox.dev/v1/auth/cli/token',
        revocationEndpoint: 'https://api.opencloudbox.dev/v1/auth/cli/revoke',
        clientId: 'ocb_cli',
        timeoutMilliseconds: 1000,
        // Mirrors the public auth error contract: structured reason plus request reference.
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: { code: 'INVALID_GRANT', reasonCode, message: 'private-canary' },
              requestId: 'req_123456abcdef',
            }),
            { status: 400, headers: { 'x-request-id': 'req_123456abcdef' } },
          ),
      })
      const error = await client.refresh({ refreshToken: 'private-canary' }).catch((value) => value)
      expect(error).toBeInstanceOf(OcboxError)
      expect(error.details).toMatchObject({ reasonCode, providerRequestId: 'req_123456abcdef' })
      expect(error.message).not.toContain('private-canary')
      expect(error.message).toContain('req_123456abcdef')
    },
  )
  it('persists only bounded reason metadata through the real atomic JSON store and expires it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ocbox-reasons-'))
    try {
      const now = Date.now()
      const first = new OcboxError({
        code: 'INVALID_STATE',
        message: 'Safe message',
        requestId: newRequestId(),
        details: { reasonCode: 'cli_auth_metadata_missing' },
      })
      expect(await recordLocalAuthFailure(directory, first, now)).toBe(true)
      let data = JSON.parse(await readFile(join(directory, 'auth-failures.json'), 'utf8'))
      expect(data.entries[0]).toMatchObject({
        requestId: first.requestId,
        reasonCode: 'cli_auth_metadata_missing',
      })
      expect(JSON.stringify(data)).not.toContain('Safe message')
      const second = new OcboxError({
        code: 'AUTH_REQUIRED',
        message: 'Safe message',
        requestId: newRequestId(),
        details: { reasonCode: 'cli_login_callback_timeout' },
      })
      expect(await recordLocalAuthFailure(directory, second, now + 8 * 86400000)).toBe(true)
      data = JSON.parse(await readFile(join(directory, 'auth-failures.json'), 'utf8'))
      expect(data.entries).toHaveLength(1)
      expect(data.entries[0].reasonCode).toBe('cli_login_callback_timeout')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

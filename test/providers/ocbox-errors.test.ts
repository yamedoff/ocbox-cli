import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertErrorRedacted } from '../../src/api/client/client.js'
import { envelopeOf, mapApiFailureToOcboxError, toRequestId } from '../../src/api/client/errors.js'
import { AuthMetadataStore } from '../../src/auth/metadata.js'
import {
  createCredentialStore,
  defaultCredentialKey,
  resolveAuthEndpoints,
} from '../../src/auth/runtime.js'
import { DEFAULT_PROJECT_CONFIG } from '../../src/cli/runtime.js'
import Start from '../../src/commands/start.js'
import { UtcTimestampSchema } from '../../src/domain/timestamps.js'
import { OcboxError } from '../../src/errors/index.js'
import { DEFAULT_API_URL } from '../../src/providers/ocbox/defaults.js'
import { OcboxSandboxProvider } from '../../src/providers/ocbox/provider.js'
import {
  HOSTED_PROJECT,
  hostedOperationFixture,
  jsonResponse,
  LOCAL_IDS,
  operationContext,
  seededApi,
  testSpec,
} from './doubles.js'

const originalExitCode = process.exitCode
const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const NEXT_STEP =
  'You have reached the number of running boxes for your plan; stop or destroy one (session_list) and retry.'

describe('hosted error mapping', () => {
  it('maps auth failures to the stable catalogue and preserves request IDs', () => {
    expect(mapApiFailureToOcboxError({ requestId: REQUEST_ID, status: 401 }).code).toBe(
      'AUTH_REQUIRED',
    )
    expect(mapApiFailureToOcboxError({ requestId: REQUEST_ID, status: 401 }).requestId).toBe(
      REQUEST_ID,
    )
    expect(
      mapApiFailureToOcboxError({ requestId: REQUEST_ID, serverCode: 'INVALID_GRANT', status: 400 })
        .code,
    ).toBe('AUTH_REQUIRED')
    expect(mapApiFailureToOcboxError({ requestId: REQUEST_ID, status: 403 }).code).toBe(
      'AUTH_FORBIDDEN',
    )
  })

  it('maps rate, quota, payment, and provider failures distinctly', () => {
    expect(
      mapApiFailureToOcboxError({ requestId: REQUEST_ID, serverCode: 'RATE_LIMITED', status: 429 })
        .code,
    ).toBe('PROVIDER_RATE_LIMIT')
    expect(
      mapApiFailureToOcboxError({
        requestId: REQUEST_ID,
        serverCode: 'SERVICE_UNAVAILABLE',
        status: 503,
      }).code,
    ).toBe('PROVIDER_UNAVAILABLE')
    expect(
      mapApiFailureToOcboxError({
        requestId: REQUEST_ID,
        serverCode: 'QUOTA_EXCEEDED',
        status: 422,
      }).code,
    ).toBe('PROVIDER_QUOTA')
    expect(
      mapApiFailureToOcboxError({
        requestId: REQUEST_ID,
        serverCode: 'PAYMENT_REQUIRED',
        status: 402,
      }).code,
    ).toBe('PAYMENT_REQUIRED')
    expect(
      mapApiFailureToOcboxError({
        requestId: REQUEST_ID,
        serverCode: 'INSUFFICIENT_CREDITS',
        status: 402,
      }).code,
    ).toBe('INSUFFICIENT_CREDITS')
  })

  it('maps operation conflicts and source integrity without losing the server code', () => {
    const conflict = mapApiFailureToOcboxError({
      operation: 'startSession',
      requestId: REQUEST_ID,
      serverCode: 'SESSION_STATE_CONFLICT',
      status: 409,
    })
    expect(conflict.code).toBe('OPERATION_CONFLICT')
    expect(conflict.providerCode).toBe('SESSION_STATE_CONFLICT')
    const integrity = mapApiFailureToOcboxError({
      requestId: REQUEST_ID,
      serverCode: 'SOURCE_INTEGRITY_FAILED',
      status: 422,
    })
    expect(integrity.code).toBe('SYNC_INTEGRITY')
  })

  it('mints a local request ID when the server ID is not a public ID', () => {
    const mapped = mapApiFailureToOcboxError({ requestId: 'srv_123', status: 503 })
    expect(String(mapped.requestId)).not.toBe('srv_123')
    expect(String(toRequestId(REQUEST_ID))).toBe(REQUEST_ID)
  })

  it('carries the API next step and keeps a REST 404 code and message', () => {
    const envelope = envelopeOf({
      error: {
        code: 'NOT_FOUND',
        message: 'Resource was not found',
        nextStep: 'Run `ocbox project list` to find your project.',
      },
      requestId: REQUEST_ID,
    })
    expect(envelope).toEqual({
      code: 'NOT_FOUND',
      message: 'Resource was not found',
      nextStep: 'Run `ocbox project list` to find your project.',
      requestId: REQUEST_ID,
    })

    const mapped = mapApiFailureToOcboxError({
      requestId: envelope.requestId,
      serverCode: envelope.code,
      serverMessage: envelope.message,
      nextStep: envelope.nextStep,
      status: 404,
    })
    expect(mapped).toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      providerCode: 'NOT_FOUND',
      message: 'Resource was not found',
      details: { nextStep: 'Run `ocbox project list` to find your project.' },
    })
  })

  it('reads the safe provider reason from an error envelope', () => {
    const envelope = envelopeOf({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Box admission was refused',
        reason: 'user_active_limit',
      },
      requestId: REQUEST_ID,
    })
    expect(envelope.reason).toBe('user_active_limit')
    expect(envelope.code).toBe('SERVICE_UNAVAILABLE')
  })

  it('reads hosted limit metadata from an error envelope', () => {
    const envelope = envelopeOf({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Box admission was refused',
        reason: 'user_active_limit',
        reasonCode: 'user_active_limit',
        nextStep: NEXT_STEP,
        limitName: 'boxes_per_account',
        limitValue: 1,
      },
      requestId: REQUEST_ID,
    })
    expect(envelope.reason).toBe('user_active_limit')
    expect(envelope.reasonCode).toBe('user_active_limit')
    expect(envelope.nextStep).toBe(NEXT_STEP)
    expect(envelope.limitName).toBe('boxes_per_account')
    expect(envelope.limitValue).toBe(1)
  })

  it('keeps every refusal field the server supplied in error details', () => {
    const mapped = mapApiFailureToOcboxError({
      requestId: REQUEST_ID,
      serverCode: 'SERVICE_UNAVAILABLE',
      serverMessage: 'Box admission was refused',
      status: 503,
      reason: 'user_active_limit',
      reasonCode: 'user_active_limit',
      nextStep: NEXT_STEP,
      limitName: 'boxes_per_account',
      limitValue: 1,
    })
    expect(mapped.details).toEqual({
      reason: 'user_active_limit',
      reasonCode: 'user_active_limit',
      nextStep: NEXT_STEP,
      limitName: 'boxes_per_account',
      limitValue: 1,
    })
  })

  it('never invents refusal fields the server omitted', () => {
    const mapped = mapApiFailureToOcboxError({
      requestId: REQUEST_ID,
      serverCode: 'SERVICE_UNAVAILABLE',
      serverMessage: 'Box admission was refused',
      status: 503,
      reason: 'user_active_limit',
      reasonCode: 'user_active_limit',
      nextStep: NEXT_STEP,
    })
    expect(mapped.details).toEqual({
      reason: 'user_active_limit',
      reasonCode: 'user_active_limit',
      nextStep: NEXT_STEP,
    })
    expect(mapped.details).not.toHaveProperty('limitName')
    expect(mapped.details).not.toHaveProperty('limitValue')
    expect(mapped.message).toBe('Box admission was refused')
    expect(mapped.message).not.toContain('boxes_per_account')
    expect(mapped.message).not.toMatch(/\blimit\b/i)
  })

  it('passes a refused create envelope through the client boundary', async () => {
    const { api } = await seededApi(async () => new Response('{}', { status: 500 }))
    const body = {
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Box admission was refused',
        reason: 'user_active_limit',
        reasonCode: 'user_active_limit',
        nextStep: NEXT_STEP,
        limitName: 'boxes_per_account',
        limitValue: 1,
      },
      requestId: REQUEST_ID,
    }
    let caught: unknown
    try {
      api.assertSuccess(
        'createSession',
        { body, replay: false, requestId: REQUEST_ID, status: 503 },
        [200, 201, 202],
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OcboxError)
    const error = caught as OcboxError
    expect(error.details).toEqual({
      operation: 'createSession',
      reason: 'user_active_limit',
      reasonCode: 'user_active_limit',
      nextStep: NEXT_STEP,
      limitName: 'boxes_per_account',
      limitValue: 1,
    })
    expect(error.message).toContain('boxes_per_account')
    expect(error.message).toContain(`Next: ${NEXT_STEP}`)
  })

  it('drops malformed refusal fields instead of throwing', () => {
    const mapped = mapApiFailureToOcboxError({
      requestId: REQUEST_ID,
      serverCode: 'SERVICE_UNAVAILABLE',
      serverMessage: 'Box admission was refused',
      status: 503,
      reason: 'user_active_limit',
      reasonCode: 'NOT-A-CODE',
      limitName: '/etc/passwd',
      limitValue: 0,
    })
    expect(mapped.details).toEqual({ reason: 'user_active_limit' })
    expect(mapped.message).toBe('Box admission was refused')
  })

  it('drops a fractional limit value instead of throwing', () => {
    const mapped = mapApiFailureToOcboxError({
      requestId: REQUEST_ID,
      serverCode: 'SERVICE_UNAVAILABLE',
      serverMessage: 'Box admission was refused',
      status: 503,
      limitName: 'boxes_per_account',
      limitValue: 1.5,
    })
    expect(mapped.details).toEqual({ limitName: 'boxes_per_account' })
    expect(mapped.details).not.toHaveProperty('limitValue')
  })

  it('names the enforced limit and next step in the human message', () => {
    const mapped = mapApiFailureToOcboxError({
      requestId: REQUEST_ID,
      serverCode: 'SERVICE_UNAVAILABLE',
      serverMessage: 'Box admission was refused',
      status: 503,
      limitName: 'boxes_per_account',
      limitValue: 1,
      nextStep: NEXT_STEP,
    })
    expect(mapped.message).toContain('Box admission was refused')
    expect(mapped.message).toContain('boxes_per_account')
    expect(mapped.message).toMatch(/\b1\b/)
    expect(mapped.message).toContain(`Next: ${NEXT_STEP}`)
    expect(mapped.details).toEqual({
      nextStep: NEXT_STEP,
      limitName: 'boxes_per_account',
      limitValue: 1,
    })
  })

  it('keeps diagnostics free of credential-like material', () => {
    const error = new OcboxError({
      code: 'PROVIDER_RATE_LIMIT',
      message: 'The hosted service rate limit was reached',
      providerCode: 'RATE_LIMITED',
      requestId: REQUEST_ID as never,
    })
    expect(() => assertErrorRedacted(error)).not.toThrow()
    expect(JSON.stringify(error.toJSON())).not.toContain('Bearer')
  })
})

const REFUSED_CREATE = {
  error: {
    code: 'SERVICE_UNAVAILABLE',
    message: 'Box admission was refused',
    retryable: false,
    reason: 'user_active_limit',
    reasonCode: 'user_active_limit',
    nextStep: NEXT_STEP,
    limitName: 'boxes_per_account',
    limitValue: 1,
  },
  requestId: REQUEST_ID,
}

describe('refused box create', () => {
  it('keeps the refusal envelope when a create operation fails', async () => {
    const { api } = await seededApi((input, init) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.endsWith(`/projects/${HOSTED_PROJECT}`) && method === 'GET') {
        return Promise.resolve(
          jsonResponse({
            createdAt: '2026-09-12T10:00:00.000Z',
            id: HOSTED_PROJECT,
            name: 'hosted project',
            updatedAt: '2026-09-12T10:00:00.000Z',
          }),
        )
      }
      if (url.endsWith(`/projects/${HOSTED_PROJECT}/sessions`) && method === 'POST') {
        return Promise.resolve(
          jsonResponse(hostedOperationFixture({ progress: 0, state: 'pending' }), 202),
        )
      }
      if (url.includes('/operations/') && method === 'GET') {
        return Promise.resolve(
          jsonResponse(hostedOperationFixture({ state: 'failed', error: REFUSED_CREATE.error })),
        )
      }
      return Promise.resolve(jsonResponse({}))
    })
    const provider = new OcboxSandboxProvider({ api, hostedProjectId: HOSTED_PROJECT })
    let caught: unknown
    try {
      await provider.create(
        operationContext() as never,
        {
          projectId: LOCAL_IDS.project,
          sessionId: LOCAL_IDS.session,
          specification: testSpec(),
        } as never,
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(OcboxError)
    const error = caught as OcboxError
    expect(error.code).toBe('USAGE_LIMIT')
    expect(error.details).toEqual({
      reason: 'user_active_limit',
      reasonCode: 'user_active_limit',
      nextStep: NEXT_STEP,
      limitName: 'boxes_per_account',
      limitValue: 1,
    })
    expect(error.message).toContain('You have reached your active session limit')
    expect(error.message).toContain('The boxes_per_account limit is 1.')
    expect(error.message).toContain(`Next: ${NEXT_STEP}`)
  })

  describe('ocbox start', () => {
    const originalEnvironment = { ...process.env }
    const roots: string[] = []
    let stdoutSpy: ReturnType<typeof vi.spyOn>
    let stderrSpy: ReturnType<typeof vi.spyOn>

    function output(spy: ReturnType<typeof vi.spyOn>): string {
      return spy.mock.calls.map((call: unknown[]) => String(call[0])).join('')
    }

    async function logIn(state: string): Promise<void> {
      const endpoints = resolveAuthEndpoints({ 'api-url': DEFAULT_API_URL }, {})
      const key = defaultCredentialKey()
      const credential = {
        accessToken: 'fixture-access-'.padEnd(48, 'a'),
        refreshToken: 'fixture-refresh-'.padEnd(48, 'r'),
        expiresAt: UtcTimestampSchema.parse(new Date(Date.now() + 3_600_000).toISOString()),
        scopes: [...endpoints.scopes],
        tokenType: 'Bearer' as const,
      }
      await createCredentialStore().set(key, credential)
      await new AuthMetadataStore(join(state, 'auth.json')).save({
        schemaVersion: 1,
        issuer: endpoints.issuer,
        clientId: endpoints.clientId,
        audience: 'cli',
        scopes: credential.scopes,
        expiresAt: credential.expiresAt,
        identity: key,
        updatedAt: UtcTimestampSchema.parse(new Date().toISOString()),
      })
    }

    beforeEach(async () => {
      process.exitCode = 0
      const root = await mkdtemp(join(tmpdir(), 'ocbox-refused-start-'))
      roots.push(root)
      process.env['HOME'] = join(root, 'home')
      process.env['XDG_CONFIG_HOME'] = join(root, 'config')
      process.env['XDG_STATE_HOME'] = join(root, 'state-home')
      process.env['APPDATA'] = join(root, 'appdata')
      process.env['LOCALAPPDATA'] = join(root, 'localappdata')
      process.env['USERPROFILE'] = join(root, 'userprofile')
      stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
      stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    })

    afterEach(async () => {
      stdoutSpy.mockRestore()
      stderrSpy.mockRestore()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      process.exitCode = originalExitCode
      for (const name of Object.keys(process.env)) {
        if (!(name in originalEnvironment)) delete process.env[name]
      }
      Object.assign(process.env, originalEnvironment)
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
    })

    it('prints the limit name, value, and next step from the exact refusal', async () => {
      const root = roots[0]
      if (root === undefined) throw new Error('Expected a temporary root')
      const config = join(root, 'opencloudbox.toml')
      const state = join(root, 'state')
      await writeFile(
        config,
        DEFAULT_PROJECT_CONFIG.replace('name = "fake"', 'name = "ocbox"').replace(
          'schemaVersion = 1',
          'schemaVersion = 1\nprojectId = "proj_refused"',
        ),
      )
      await logIn(state)
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown, init?: RequestInit) => {
          const url = new URL(String(input))
          if (url.pathname === '/v1/projects/proj_refused' && (init?.method ?? 'GET') === 'GET') {
            return jsonResponse({
              createdAt: '2026-09-12T10:00:00.000Z',
              id: 'proj_refused',
              name: 'refused',
              updatedAt: '2026-09-12T10:00:00.000Z',
            })
          }
          if (url.pathname === '/v1/projects/proj_refused/sessions' && init?.method === 'POST') {
            return new Response(JSON.stringify(REFUSED_CREATE), {
              headers: { 'x-request-id': REQUEST_ID },
              status: 503,
            })
          }
          return jsonResponse({})
        }),
      )

      await Start.run(['--config', config, '--state-dir', state, '--api-url', DEFAULT_API_URL], {
        root: process.cwd(),
      })

      expect(process.exitCode).toBe(1)
      expect(output(stdoutSpy)).toBe('')
      const stderr = output(stderrSpy)
      expect(stderr).toContain('You have reached your active session limit')
      expect(stderr).toContain('The boxes_per_account limit is 1.')
      expect(stderr).toContain(`Next: ${NEXT_STEP}`)
      expect(stderr).toContain('Reason user_active_limit.')
    })
  })
})

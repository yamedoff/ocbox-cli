import { describe, expect, it } from 'vitest'
import { OcboxSandboxProvider } from '../../src/providers/ocbox/provider.js'
import type { HostedSessionCache } from '../../src/providers/ocbox/session-cache.js'
import type { HostedSession } from '../../src/providers/ocbox/wire.js'
import {
  HOSTED_PROJECT,
  HOSTED_SANDBOX,
  HOSTED_SESSION,
  hostedSessionFixture,
  jsonResponse,
  LOCAL_IDS,
  operationContext,
  seededApi,
  testSpec,
} from './doubles.js'

const HOSTED_EXECUTION = 'exec_hosted_cache_1'
const STARTED_AT = '2026-09-12T10:00:00.000Z'
const COMPLETED_AT = '2026-09-12T10:00:01.000Z'

function executionFixture(): Record<string, unknown> {
  return {
    command: 'echo hi',
    createdAt: STARTED_AT,
    exitCode: null,
    failure: null,
    failureKind: null,
    id: HOSTED_EXECUTION,
    outputBytes: 0,
    outputLimitBytes: 1048576,
    sandboxId: HOSTED_SANDBOX,
    sessionId: HOSTED_SESSION,
    state: 'running',
    truncated: false,
    updatedAt: STARTED_AT,
  }
}

describe('execution session read reuse', () => {
  it('reads the hosted Session once for the execution target and the execution start', async () => {
    let sessionGets = 0
    const { api } = await seededApi((input, init) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.endsWith(`/sessions/${HOSTED_SESSION}`) && method === 'GET') {
        sessionGets += 1
        return Promise.resolve(jsonResponse(hostedSessionFixture({})))
      }
      if (url.endsWith(`/sessions/${HOSTED_SESSION}/executions`) && method === 'POST') {
        return Promise.resolve(jsonResponse(executionFixture(), 202))
      }
      if (url.includes(`/executions/${HOSTED_EXECUTION}/events`)) {
        return Promise.resolve(
          jsonResponse({
            data: [
              { at: STARTED_AT, kind: 'started', message: '', sequence: 0, stream: null },
              { at: STARTED_AT, kind: 'stdout', message: 'hi', sequence: 1, stream: 'stdout' },
              { at: COMPLETED_AT, kind: 'completed', message: '', sequence: 2, stream: null },
            ],
            nextCursor: null,
          }),
        )
      }
      if (url.includes(`/executions/${HOSTED_EXECUTION}/result`)) {
        return Promise.resolve(
          jsonResponse({
            exitCode: 0,
            kind: 'command',
            outputBytes: 2,
            outputLimitBytes: 1048576,
            stderr: '',
            stdout: 'hi',
            truncated: false,
          }),
        )
      }
      return Promise.resolve(jsonResponse({}))
    })
    const provider = new OcboxSandboxProvider({ api, hostedProjectId: HOSTED_PROJECT })
    provider.seedForTests({
      hostedSandboxId: HOSTED_SANDBOX,
      hostedSessionId: HOSTED_SESSION,
      localId: LOCAL_IDS.sandbox,
      localProjectId: LOCAL_IDS.project,
      localSessionId: LOCAL_IDS.session,
      spec: testSpec() as never,
    })
    const context = operationContext()

    // What `executionTarget` does before `ExecutionService.start`.
    await provider.get(context as never, { sandboxId: LOCAL_IDS.sandbox } as never)
    // What `ExecutionService.start` then does.
    const handle = await provider.exec.execute(
      context as never,
      {
        command: { argv: ['echo', 'hi'], mode: 'argv' },
        environment: {},
        sandboxId: LOCAL_IDS.sandbox,
        timeoutMilliseconds: null,
        workingDirectory: null,
      } as never,
    )
    await handle.result

    expect(sessionGets).toBe(1)
  })

  it('reuses a warm cache across commands and reads directly on a cache miss', async () => {
    let sessionGets = 0
    const { api } = await seededApi((input, init) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.endsWith(`/sessions/${HOSTED_SESSION}`) && method === 'GET') {
        sessionGets += 1
        return Promise.resolve(jsonResponse(hostedSessionFixture({})))
      }
      return Promise.resolve(jsonResponse({}))
    })
    const sessions = new Map<string, HostedSession>()
    const cache: HostedSessionCache = {
      get: (hostedSessionId) => Promise.resolve(sessions.get(hostedSessionId) ?? null),
      remember: (hostedSessionId, session) => {
        sessions.set(hostedSessionId, session)
      },
    }
    const seed = (provider: OcboxSandboxProvider): void => {
      provider.seedForTests({
        hostedSandboxId: HOSTED_SANDBOX,
        hostedSessionId: HOSTED_SESSION,
        localId: LOCAL_IDS.sandbox,
        localProjectId: LOCAL_IDS.project,
        localSessionId: LOCAL_IDS.session,
        spec: testSpec() as never,
      })
    }
    const context = operationContext()
    const first = new OcboxSandboxProvider({
      api,
      hostedProjectId: HOSTED_PROJECT,
      sessionCache: cache,
    })
    seed(first)
    await first.get(context as never, { sandboxId: LOCAL_IDS.sandbox } as never)
    expect(sessionGets).toBe(1)

    // A later CLI command is a new provider instance but shares the daemon cache.
    const second = new OcboxSandboxProvider({
      api,
      hostedProjectId: HOSTED_PROJECT,
      sessionCache: cache,
    })
    seed(second)
    const observed = await second.get(context as never, { sandboxId: LOCAL_IDS.sandbox } as never)
    expect(observed?.id).toBe(LOCAL_IDS.sandbox)
    expect(sessionGets).toBe(1)

    // An absent cache entry falls back to the direct read.
    sessions.clear()
    const third = new OcboxSandboxProvider({
      api,
      hostedProjectId: HOSTED_PROJECT,
      sessionCache: cache,
    })
    seed(third)
    await third.get(context as never, { sandboxId: LOCAL_IDS.sandbox } as never)
    expect(sessionGets).toBe(2)
  })
})

import { describe, expect, it } from 'vitest'
import { OcboxSandboxProvider } from '../../src/providers/ocbox/provider.js'
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
})

import { describe, expect, it } from 'vitest'
import {
  type ClaudeHookDenyDecision,
  type ClaudeHookExecResult,
  runClaudeRoutingHook,
} from '../../../src/agents/claude-code/hook.js'
import { SessionSchema } from '../../../src/contracts.js'
import {
  type ExecutionTarget,
  type ExecutionWritable,
  runExecutionCommandResult,
} from '../../../src/execution/index.js'
import { OcboxSandboxProvider } from '../../../src/providers/ocbox/provider.js'
import {
  HOSTED_PROJECT,
  HOSTED_SANDBOX,
  HOSTED_SESSION,
  LOCAL_IDS,
  hostedSessionFixture,
  jsonResponse,
  seededApi,
  testSpec,
} from '../../providers/doubles.js'

const EXECUTION_ID = 'exec_effective_1'
const STARTED_AT = '2026-09-12T10:02:00.000Z'
const BINDING_ID = '77777777-7777-4777-8777-777777777777'

class MemoryWritable implements ExecutionWritable {
  readonly chunks: Buffer[] = []

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(Buffer.from(chunk))
    return true
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

function makeIo(): { stdout: MemoryWritable; stderr: MemoryWritable } {
  return { stderr: new MemoryWritable(), stdout: new MemoryWritable() }
}

function hookPayload(command: string): string {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } })
}

/**
 * Hosted routes for a mapped sandbox plus one completed remote execution. The
 * effective spec is exactly what the hosted Session reports, so the provider
 * mapping (not the requested spec) decides whether the shell route is valid.
 */
function hostedRoutes(effectiveSpec: Record<string, unknown>): {
  commands: string[]
  fetchImpl: (input: unknown, init?: RequestInit) => Promise<Response>
} {
  const commands: string[] = []
  const fetchImpl = (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.endsWith(`/sessions/${HOSTED_SESSION}`) && method === 'GET') {
      return Promise.resolve(jsonResponse(hostedSessionFixture({ effectiveSpec })))
    }
    if (url.endsWith(`/sessions/${HOSTED_SESSION}/executions`) && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { command?: unknown }
      commands.push(typeof body.command === 'string' ? body.command : '')
      return Promise.resolve(
        jsonResponse(
          {
            createdAt: STARTED_AT,
            id: EXECUTION_ID,
            sandboxId: HOSTED_SANDBOX,
            sessionId: HOSTED_SESSION,
            state: 'running',
          },
          202,
        ),
      )
    }
    if (url.includes(`/executions/${EXECUTION_ID}/events`)) {
      return Promise.resolve(
        jsonResponse({
          data: [
            { at: STARTED_AT, kind: 'started', message: '', sequence: 0, stream: null },
            {
              at: '2026-09-12T10:02:01.000Z',
              kind: 'stdout',
              message: 'hi',
              sequence: 1,
              stream: 'stdout',
            },
            {
              at: '2026-09-12T10:02:02.000Z',
              kind: 'completed',
              message: '',
              sequence: 2,
              stream: null,
            },
          ],
          nextCursor: null,
        }),
      )
    }
    if (url.includes(`/executions/${EXECUTION_ID}/result`)) {
      return Promise.resolve(
        jsonResponse({
          exitCode: 0,
          kind: 'command',
          outputBytes: 2,
          outputLimitBytes: 65_536,
          stderr: '',
          stdout: '',
          truncated: false,
        }),
      )
    }
    return Promise.resolve(jsonResponse({}))
  }
  return { commands, fetchImpl }
}

/**
 * Builds the real hosted provider, maps a Sandbox from the hosted Session
 * (through `get`), and wraps it in an execution target exactly as the lifecycle
 * service would. This is the seam D1 broke: the hosted `effectiveSpec` must
 * reach `Sandbox.specification.effective`.
 */
async function hostedExecutionTarget(effectiveSpec: Record<string, unknown>): Promise<{
  commands: string[]
  target: ExecutionTarget
}> {
  const { commands, fetchImpl } = hostedRoutes(effectiveSpec)
  const { api } = await seededApi(fetchImpl)
  const provider = new OcboxSandboxProvider({
    api,
    hostedProjectId: HOSTED_PROJECT,
    now: () => STARTED_AT,
  })
  provider.seedForTests({
    hostedSandboxId: HOSTED_SANDBOX,
    hostedSessionId: HOSTED_SESSION,
    localId: LOCAL_IDS.sandbox,
    localProjectId: LOCAL_IDS.project,
    localSessionId: LOCAL_IDS.session,
    spec: testSpec() as never,
  })
  const requestContext = { issuedAt: STARTED_AT, requestId: LOCAL_IDS.request }
  const sandbox = await provider.get(
    requestContext as never,
    {
      sandboxId: LOCAL_IDS.sandbox,
    } as never,
  )
  if (sandbox === null) throw new TypeError('The hosted Sandbox mapping was not returned')
  const session = SessionSchema.parse({
    bindings: [
      {
        boundAt: sandbox.createdAt,
        id: BINDING_ID,
        ordinal: 0,
        releasedAt: null,
        role: 'primary',
        sandboxId: sandbox.id,
        sessionId: LOCAL_IDS.session,
      },
    ],
    createdAt: sandbox.createdAt,
    currentOperationId: null,
    id: LOCAL_IDS.session,
    projectId: LOCAL_IDS.project,
    providerVerifiedAt: sandbox.lifecycle.observedAt,
    sandboxDeletionVerifiedAt: null,
    state: 'active',
    updatedAt: sandbox.lifecycle.observedAt,
  })
  const capabilities = await provider.capabilities(requestContext as never)
  return { commands, target: { capabilities, provider, sandbox, session } }
}

/**
 * Mirrors the production hook invoker: the emitted `ocbox exec` argv is run
 * through the real provider-neutral runner against the hosted target.
 */
function targetInvoker(
  target: ExecutionTarget,
): (argv: readonly string[]) => Promise<ClaudeHookExecResult> {
  const io = makeIo()
  return async (argv) => {
    const result = await runExecutionCommandResult(argv.slice(1), async () => target, io)
    return { exitCode: result.exitCode, outcome: result.outcome.kind, started: result.started }
  }
}

async function runHook(
  target: ExecutionTarget,
  command: string,
): Promise<{
  decisions: ClaudeHookDenyDecision[]
  errors: string[]
  exitCode: number
}> {
  const decisions: ClaudeHookDenyDecision[] = []
  const errors: string[] = []
  const exitCode = await runClaudeRoutingHook({
    environment: {},
    invokeExec: targetInvoker(target),
    rawInput: hookPayload(command),
    sessionId: LOCAL_IDS.session,
    writeDecision: (decision) => {
      decisions.push(decision)
    },
    writeError: (message) => {
      errors.push(message)
    },
  })
  return { decisions, errors, exitCode }
}

describe('hosted effective spec reaches the claude-code shell route', () => {
  it('routes a Linux effective spec to remote shell execution and denies the local copy', async () => {
    const effectiveSpec = { ...testSpec(), cpu: { millicores: 2000 } }
    const { commands, target } = await hostedExecutionTarget(effectiveSpec)
    expect(target.sandbox?.specification.effective?.operatingSystem).toBe('linux')

    const { decisions, exitCode } = await runHook(target, 'echo hi')

    expect(exitCode).toBe(2)
    expect(commands).toEqual(['echo hi'])
    expect(decisions[0]?.hookSpecificOutput.permissionDecisionReason).toContain(
      'ocbox-block[route]',
    )
  })

  it('blocks a non-Linux effective spec before any remote shell execution', async () => {
    const effectiveSpec = { ...testSpec(), operatingSystem: 'windows' }
    const { commands, target } = await hostedExecutionTarget(effectiveSpec)
    expect(target.sandbox?.specification.effective?.operatingSystem).toBe('windows')

    const { decisions, exitCode } = await runHook(target, 'echo hi')

    expect(exitCode).toBe(2)
    expect(commands).toEqual([])
    expect(decisions[0]?.hookSpecificOutput.permissionDecisionReason).toContain(
      'ocbox-block[guard]',
    )
  })

  it('blocks an unobserved effective spec instead of promoting the Linux request', async () => {
    const { commands, target } = await hostedExecutionTarget({ operatingSystem: 'linux' })
    expect(target.sandbox?.specification.effective).toBeNull()
    expect(target.sandbox?.specification.requested.operatingSystem).toBe('linux')

    const { decisions, exitCode } = await runHook(target, 'echo hi')

    expect(exitCode).toBe(2)
    expect(commands).toEqual([])
    expect(decisions[0]?.hookSpecificOutput.permissionDecisionReason).toContain(
      'ocbox-block[guard]',
    )
  })
})

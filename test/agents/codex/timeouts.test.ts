import { describe, expect, it } from 'vitest'
import { parseHooksJsonDocument, parseTomlDocument } from '../../../src/agents/codex/codec.js'
import {
  buildHookCommand,
  HOOK_FAIL_CLOSED_EXIT_CODE,
  planCodexHookRoute,
} from '../../../src/agents/codex/hook-helper.js'
import { runCodexRoutingHook } from '../../../src/agents/codex/hook.js'
import { planCodexSetup, type SetupPlanInput } from '../../../src/agents/codex/planner.js'
import { resolveCodexPaths } from '../../../src/agents/codex/paths.js'
import {
  assertCodexHookTimeoutOrdering,
  CODEX_HOOK_REMOTE_TIMEOUT_MILLISECONDS,
  CODEX_HOOK_TIMEOUT_EVIDENCE,
  CODEX_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS,
  CODEX_HOOK_TIMEOUT_SECONDS,
  MILLISECONDS_PER_SECOND,
} from '../../../src/agents/codex/timeouts.js'

const SESSION = '11111111-1111-4111-8111-111111111111'
const VERSION_TEXT = 'codex-cli 0.153.4'
const TIMESTAMP = '2026-09-12T00:00:00.000Z'

function codexPayload(command: string): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'codex-thread-1',
    tool_name: 'Bash',
    tool_input: { command },
  })
}

function userPaths(stateDirectory = '/state') {
  return resolveCodexPaths({
    platform: 'linux',
    homeDirectory: '/home/ada',
    environment: {},
    stateDirectory,
  })
}

function setupInput(overrides: Partial<SetupPlanInput> = {}): SetupPlanInput {
  return {
    versionText: VERSION_TEXT,
    layer: 'user',
    trustLevel: null,
    sessionId: SESSION,
    paths: userPaths(),
    baseTomlText: null,
    baseHooksText: null,
    timestamp: TIMESTAMP,
    ...overrides,
  }
}

function ownedHook(document: unknown): { readonly timeout?: unknown } {
  const hooks = (document as { hooks?: { PreToolUse?: unknown[] } }).hooks
  const entry = (hooks?.PreToolUse?.[0] ?? {}) as { hooks?: unknown[] }
  return (entry.hooks?.[0] ?? {}) as { readonly timeout?: unknown }
}

describe('codex PreToolUse hook timeout contract (D3)', () => {
  it('orders the remote execution timeout strictly inside the hook deadline', () => {
    const hookDeadlineMilliseconds = CODEX_HOOK_TIMEOUT_SECONDS * MILLISECONDS_PER_SECOND
    expect(CODEX_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS).toBeGreaterThan(0)
    expect(CODEX_HOOK_REMOTE_TIMEOUT_MILLISECONDS).toBeGreaterThan(0)
    expect(CODEX_HOOK_REMOTE_TIMEOUT_MILLISECONDS).toBeLessThan(hookDeadlineMilliseconds)
    expect(hookDeadlineMilliseconds - CODEX_HOOK_REMOTE_TIMEOUT_MILLISECONDS).toBe(
      CODEX_HOOK_TIMEOUT_SAFETY_MARGIN_MILLISECONDS,
    )
    expect(() => assertCodexHookTimeoutOrdering()).not.toThrow()
  })

  it('proves the deadline is expressible in the pinned command-handler schema', () => {
    expect(CODEX_HOOK_TIMEOUT_EVIDENCE.handler).toBe('type = "command"')
    expect(CODEX_HOOK_TIMEOUT_EVIDENCE.field).toBe('timeout')
    expect(CODEX_HOOK_TIMEOUT_EVIDENCE.units).toBe('seconds')
    expect(CODEX_HOOK_TIMEOUT_EVIDENCE.blockingEvent).toBe('PreToolUse')
    expect(CODEX_HOOK_TIMEOUT_EVIDENCE.emittedSeconds).toBe(CODEX_HOOK_TIMEOUT_SECONDS)
  })

  it('emits the supported hook timeout on the installed command handler', () => {
    const plan = planCodexSetup(setupInput())
    expect(plan.ok).toBe(true)
    const after = plan.changes.find((change) => change.kind === 'hooks-write')?.after ?? ''
    const document = parseHooksJsonDocument(after)
    expect(ownedHook(document).timeout).toBe(CODEX_HOOK_TIMEOUT_SECONDS)
  })

  it('emits the same deadline in the config-toml representation', () => {
    const plan = planCodexSetup(setupInput({ preferredRepresentation: 'config-toml' }))
    expect(plan.ok).toBe(true)
    const after = plan.changes.find((change) => change.kind === 'toml-merge')?.after ?? ''
    expect(after).toContain(`timeout = ${CODEX_HOOK_TIMEOUT_SECONDS}`)
    expect(ownedHook(parseTomlDocument(after)).timeout).toBe(CODEX_HOOK_TIMEOUT_SECONDS)
  })

  it('reconciles the explicit timeout onto an owned hook installed before D3', () => {
    const previous = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: buildHookCommand({ sessionId: SESSION }) }],
          },
        ],
      },
    })
    const plan = planCodexSetup(setupInput({ baseHooksText: previous }))
    expect(plan.ok).toBe(true)
    const after = plan.changes.find((change) => change.kind === 'hooks-write')?.after ?? ''
    const document = parseHooksJsonDocument(after)
    expect(ownedHook(document).timeout).toBe(CODEX_HOOK_TIMEOUT_SECONDS)
  })

  it('passes the bounded remote timeout in the routed exec argv', () => {
    const decision = planCodexHookRoute({
      payload: {
        hookEventName: 'PreToolUse',
        sessionId: SESSION,
        toolName: 'Bash',
        command: 'npm test',
      },
      sessionId: SESSION,
      environment: {},
    })
    expect(decision.action).toBe('route')
    const argv = decision.execArgv ?? []
    const timeoutIndex = argv.indexOf('--timeout')
    expect(timeoutIndex).toBeGreaterThan(-1)
    expect(argv[timeoutIndex + 1]).toBe(String(CODEX_HOOK_REMOTE_TIMEOUT_MILLISECONDS))
    expect(Number(argv[timeoutIndex + 1])).toBeLessThan(
      CODEX_HOOK_TIMEOUT_SECONDS * MILLISECONDS_PER_SECOND,
    )
  })

  it('still blocks local execution when the routed run is cancelled or times out', async () => {
    for (const exitCode of [124, 130]) {
      const decisions: string[] = []
      const hookExit = await runCodexRoutingHook({
        rawInput: codexPayload('npm test'),
        sessionId: SESSION,
        environment: {},
        invokeExec: async () => exitCode,
        writeError: () => undefined,
        writeDecision: (json) => decisions.push(json),
      })
      expect(hookExit).toBe(0)
      expect(decisions).toHaveLength(1)
      expect(decisions[0]).toContain('"permissionDecision":"deny"')
      expect(decisions[0]).toContain(`exit ${exitCode}`)
    }
  })

  it('still blocks local execution when the routed process is cancelled mid-flight', async () => {
    // Reconciled with the accepted D6/F1 redaction: an invoker throw reports no
    // remote outcome, so the hook fails closed with exit 2 (which still blocks
    // the local Bash copy) and a bounded static message — the raw exec-layer
    // error is never interpolated into stderr or the deny decision.
    const decisions: string[] = []
    const errors: string[] = []
    const hookExit = await runCodexRoutingHook({
      rawInput: codexPayload('npm test'),
      sessionId: SESSION,
      environment: {},
      invokeExec: async () => {
        throw new Error('host cancelled the hook process')
      },
      writeError: (message) => errors.push(message),
      writeDecision: (json) => decisions.push(json),
    })
    expect(hookExit).toBe(HOOK_FAIL_CLOSED_EXIT_CODE)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toContain('"permissionDecision":"deny"')
    expect(errors.join(' ')).toContain('failing closed')
    expect(errors.join(' ')).not.toContain('host cancelled the hook process')
    expect(decisions.join(' ')).not.toContain('host cancelled the hook process')
  })
})

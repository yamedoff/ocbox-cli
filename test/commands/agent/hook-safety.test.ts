import { describe, expect, it } from 'vitest'
import type {
  ClaudeHookDenyDecision,
  ClaudeHookExecResult,
} from '../../../src/agents/claude-code/hook.js'
import { CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS } from '../../../src/agents/claude-code/timeouts.js'
import { type AgentHookSafetyDeps, runAgentHookSafely } from '../../../src/commands/agent/hook.js'

const SESSION = '11111111-1111-4111-8111-111111111111'
const REMOTE_SUCCESS: ClaudeHookExecResult = {
  started: true,
  exitCode: 0,
  outcome: 'remote_result',
}

function payload(command = 'npm test'): string {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } })
}

interface HarnessOptions {
  readonly adapter?: string
  readonly readInput?: () => Promise<string>
  readonly sessionId?: string | null
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly result?: ClaudeHookExecResult
  readonly invokeExec?: (argv: readonly string[]) => Promise<ClaudeHookExecResult>
  readonly writeError?: (message: string) => void
  readonly writeDecision?: (decision: ClaudeHookDenyDecision) => void
}

interface Harness {
  readonly deps: AgentHookSafetyDeps
  readonly calls: string[][]
  readonly errors: string[]
  readonly decisions: ClaudeHookDenyDecision[]
}

function harness(options: HarnessOptions = {}): Harness {
  const calls: string[][] = []
  const errors: string[] = []
  const decisions: ClaudeHookDenyDecision[] = []
  const deps: AgentHookSafetyDeps = {
    adapter: options.adapter ?? 'claude-code',
    readInput: options.readInput ?? (async () => payload()),
    sessionId: options.sessionId === undefined ? SESSION : options.sessionId,
    environment: options.environment ?? {},
    invokeExec: async (argv) => {
      calls.push([...argv])
      if (options.invokeExec !== undefined) return await options.invokeExec(argv)
      return options.result ?? REMOTE_SUCCESS
    },
    writeError:
      options.writeError ??
      ((message) => {
        errors.push(message)
      }),
    writeDecision:
      options.writeDecision ??
      ((decision) => {
        decisions.push(decision)
      }),
  }
  return { deps, calls, errors, decisions }
}

function reason(decision: ClaudeHookDenyDecision | undefined): string {
  return decision?.hookSpecificOutput.permissionDecisionReason ?? ''
}

describe('agent hook fail-closed error boundary (D2)', () => {
  it('converts an unexpected stdin read error into a guard denial and exit 2', async () => {
    const { deps, calls, errors, decisions } = harness({
      readInput: async () => {
        throw new Error('stdin EPIPE')
      },
    })
    const exitCode = await runAgentHookSafely(deps)
    expect(exitCode).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errors.join('\n')).toContain('ocbox-block[guard]')
    expect(errors.join('\n')).toContain('failing closed')
    expect(decisions).toHaveLength(1)
    expect(reason(decisions[0])).toContain('ocbox-block[guard]')
    expect(decisions[0]?.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('fails closed when the payload cannot be parsed', async () => {
    const { deps, errors, decisions } = harness({
      readInput: async () => '{ definitely not json',
    })
    const exitCode = await runAgentHookSafely(deps)
    expect(exitCode).toBe(2)
    expect(errors).toHaveLength(1)
    expect(reason(decisions[0])).toContain('ocbox-block[guard]')
  })

  it('never lets a decision-writer failure escape or trigger a second execution', async () => {
    let writeAttempts = 0
    const { deps, calls, decisions } = harness({
      writeDecision: (decision) => {
        writeAttempts += 1
        if (writeAttempts === 1) throw new Error('stdout closed')
        decisions.push(decision)
      },
    })
    const exitCode = await runAgentHookSafely(deps)
    expect(exitCode).toBe(2)
    // The routed command ran exactly once; a writer failure is not retried into
    // a second execution.
    expect(calls).toHaveLength(1)
    expect(decisions).toHaveLength(1)
    const fallback = reason(decisions[0])
    expect(fallback).toContain('ocbox-block[guard]')
    // The fallback must not claim a remote exit code it never observed.
    expect(fallback).not.toContain('exit-code=')
  })

  it('survives a stderr writer failure and still emits the guard decision', async () => {
    const { deps, calls, decisions } = harness({
      writeError: () => {
        throw new Error('stderr closed')
      },
    })
    const exitCode = await runAgentHookSafely(deps)
    expect(exitCode).toBe(2)
    expect(calls).toHaveLength(1)
    expect(reason(decisions[0])).toContain('ocbox-block[guard]')
  })

  it('stays fail-closed when both writers are unwritable', async () => {
    const { deps } = harness({
      readInput: async () => {
        throw new Error('stdin reset')
      },
      writeError: () => {
        throw new Error('stderr closed')
      },
      writeDecision: () => {
        throw new Error('stdout closed')
      },
    })
    await expect(runAgentHookSafely(deps)).resolves.toBe(2)
  })

  it('redacts a credential carried by an unexpected error', async () => {
    const { deps, errors, decisions } = harness({
      readInput: async () => {
        throw new Error('failed reading config token=sk-supersecretvalue123')
      },
    })
    await runAgentHookSafely(deps)
    const output = `${errors.join('\n')}\n${reason(decisions[0])}`
    expect(output).toContain('[REDACTED]')
    expect(output).not.toContain('sk-supersecretvalue123')
  })

  it('redacts a host-local path carried by an unexpected error', async () => {
    const { deps, errors, decisions } = harness({
      readInput: async () => {
        throw new Error('cannot open /home/ada/.config/claude.json')
      },
    })
    await runAgentHookSafely(deps)
    const output = `${errors.join('\n')}\n${reason(decisions[0])}`
    expect(output).toContain('[LOCAL_PATH]')
    expect(output).not.toContain('/home/ada/.config/claude.json')
  })

  it('returns exit 2 for an unknown adapter without consuming stdin', async () => {
    let read = false
    const { deps, calls, errors, decisions } = harness({
      adapter: 'codex',
      readInput: async () => {
        read = true
        return payload()
      },
    })
    const exitCode = await runAgentHookSafely(deps)
    expect(exitCode).toBe(2)
    expect(read).toBe(false)
    expect(calls).toHaveLength(0)
    expect(decisions).toHaveLength(0)
    expect(errors[0]).toContain('only "claude-code" is supported')
  })

  it('preserves the T11 bounded-timeout routing contract through the boundary', async () => {
    const { deps, calls, decisions } = harness()
    const exitCode = await runAgentHookSafely(deps)
    expect(exitCode).toBe(2)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([
      'exec',
      '--session',
      SESSION,
      '--timeout',
      String(CLAUDE_CODE_HOOK_REMOTE_TIMEOUT_MILLISECONDS),
      '--shell',
      'npm test',
      '--env',
      'OCBOX_AGENT_ROUTED=1',
      '--env',
      'OCBOX_AGENT_ADAPTER=claude-code',
    ])
    expect(reason(decisions[0])).toContain('ocbox-block[route]')
  })

  it('leaves an uncovered tool local with exit 0 and no writers touched', async () => {
    const { deps, calls, decisions } = harness({
      readInput: async () =>
        JSON.stringify({ tool_name: 'Edit', tool_input: { command: 'npm test' } }),
    })
    const exitCode = await runAgentHookSafely(deps)
    expect(exitCode).toBe(0)
    expect(calls).toHaveLength(0)
    expect(decisions).toHaveLength(0)
  })
})

import { describe, expect, it } from 'vitest'
import { codexPreToolUseDenyDecision } from '../../../src/agents/codex/hook-contract.js'
import {
  type CodexHookSafetyDeps,
  runCodexAgentHookSafely,
} from '../../../src/commands/agent/hook.js'

const SESSION = '11111111-1111-4111-8111-111111111111'

function payload(command = 'npm test'): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'codex-thread-1',
    tool_name: 'Bash',
    tool_input: { command },
  })
}

interface HarnessOptions {
  readonly adapter?: string
  readonly readInput?: () => Promise<string>
  readonly sessionId?: string | null
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly exitCode?: number
  readonly invokeExec?: (argv: readonly string[]) => Promise<number>
  readonly writeError?: (message: string) => void
  readonly writeDecision?: (json: string) => void
}

interface Harness {
  readonly deps: CodexHookSafetyDeps
  readonly calls: string[][]
  readonly errors: string[]
  readonly decisions: string[]
}

function harness(options: HarnessOptions = {}): Harness {
  const calls: string[][] = []
  const errors: string[] = []
  const decisions: string[] = []
  const deps: CodexHookSafetyDeps = {
    adapter: options.adapter ?? 'codex',
    readInput: options.readInput ?? (async () => payload()),
    sessionId: options.sessionId === undefined ? SESSION : options.sessionId,
    environment: options.environment ?? {},
    invokeExec: async (argv) => {
      calls.push([...argv])
      if (options.invokeExec !== undefined) return await options.invokeExec(argv)
      return options.exitCode ?? 0
    },
    writeError:
      options.writeError ??
      ((message) => {
        errors.push(message)
      }),
    writeDecision:
      options.writeDecision ??
      ((json) => {
        decisions.push(json)
      }),
  }
  return { deps, calls, errors, decisions }
}

function reason(json: string | undefined): string {
  if (json === undefined) return ''
  const parsed = JSON.parse(json) as {
    readonly hookSpecificOutput?: { readonly permissionDecisionReason?: string }
  }
  return parsed.hookSpecificOutput?.permissionDecisionReason ?? ''
}

function decisionField(json: string | undefined): string {
  if (json === undefined) return ''
  const parsed = JSON.parse(json) as {
    readonly hookSpecificOutput?: { readonly permissionDecision?: string }
  }
  return parsed.hookSpecificOutput?.permissionDecision ?? ''
}

describe('agent hook fail-closed error boundary (codex, F1/F2/D6)', () => {
  it('converts an unexpected stdin read error into a guard deny and exit 2', async () => {
    const { deps, calls, errors, decisions } = harness({
      readInput: async () => {
        throw new Error('stdin EPIPE')
      },
    })
    const exitCode = await runCodexAgentHookSafely(deps)
    expect(exitCode).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errors.join('\n')).toContain('ocbox codex router')
    expect(errors.join('\n')).toContain('failing closed')
    expect(decisions).toHaveLength(1)
    expect(decisionField(decisions[0])).toBe('deny')
    expect(reason(decisions[0])).toContain('failing closed')
  })

  it('fails closed with exit 2 and a static deny when the exec invoker throws', async () => {
    const { deps, calls, errors, decisions } = harness({
      invokeExec: async () => {
        throw new Error('routed exec transport failed')
      },
    })
    const exitCode = await runCodexAgentHookSafely(deps)
    expect(exitCode).toBe(2)
    expect(calls).toHaveLength(1)
    expect(decisions).toHaveLength(1)
    expect(decisionField(decisions[0])).toBe('deny')
    expect(reason(decisions[0])).toContain('routed execution failed before reporting an outcome')
    expect(errors.join('\n')).toContain('routed execution failed before reporting an outcome')
    expect(errors.join('\n')).not.toContain('routed exec transport failed')
  })

  it('fails closed on an unreadable payload with a deny decision', async () => {
    const { deps, errors, decisions } = harness({ readInput: async () => '{ definitely not json' })
    const exitCode = await runCodexAgentHookSafely(deps)
    expect(exitCode).toBe(2)
    expect(errors.join('\n')).toContain('failing closed')
    expect(decisions).toHaveLength(1)
    expect(decisionField(decisions[0])).toBe('deny')
  })

  it('never lets a decision-writer failure escape or trigger a second execution', async () => {
    let writeAttempts = 0
    const { deps, calls, errors, decisions } = harness({
      writeDecision: (json) => {
        writeAttempts += 1
        if (writeAttempts === 1) throw new Error('stdout closed')
        decisions.push(json)
      },
    })
    const exitCode = await runCodexAgentHookSafely(deps)
    expect(exitCode).toBe(2)
    expect(calls).toHaveLength(1)
    expect(decisions).toHaveLength(1)
    expect(decisionField(decisions[0])).toBe('deny')
    expect(reason(decisions[0])).toContain('failing closed')
    expect(errors.join('\n')).not.toContain('remote exit')
  })

  it('survives a stderr writer failure and still emits the deny decision', async () => {
    const { deps, calls, decisions } = harness({
      readInput: async () => {
        throw new Error('stdin reset')
      },
      writeError: () => {
        throw new Error('stderr closed')
      },
    })
    const exitCode = await runCodexAgentHookSafely(deps)
    expect(exitCode).toBe(2)
    expect(calls).toHaveLength(0)
    expect(decisions).toHaveLength(1)
    expect(decisionField(decisions[0])).toBe('deny')
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
    await expect(runCodexAgentHookSafely(deps)).resolves.toBe(2)
  })

  it('redacts a credential carried by an unexpected error', async () => {
    const { deps, errors, decisions } = harness({
      readInput: async () => {
        throw new Error('failed reading config token=sk-supersecretvalue123')
      },
    })
    await runCodexAgentHookSafely(deps)
    const output = `${errors.join('\n')}\n${reason(decisions[0])}`
    expect(output).toContain('[REDACTED]')
    expect(output).not.toContain('sk-supersecretvalue123')
  })

  it('redacts a host-local path carried by an unexpected error', async () => {
    const { deps, errors, decisions } = harness({
      readInput: async () => {
        throw new Error('cannot open /home/ada/.codex/config.toml')
      },
    })
    await runCodexAgentHookSafely(deps)
    const output = `${errors.join('\n')}\n${reason(decisions[0])}`
    expect(output).toContain('[LOCAL_PATH]')
    expect(output).not.toContain('/home/ada/.codex/config.toml')
  })

  it('does not leak a secret or path carried by a throwing exec invoker', async () => {
    const { deps, errors, decisions } = harness({
      invokeExec: async () => {
        throw new Error('auth failed token=sk-supersecretvalue123 at /home/ada/.codex/x')
      },
    })
    await runCodexAgentHookSafely(deps)
    const output = `${errors.join('\n')}`
    expect(output).not.toContain('sk-supersecretvalue123')
    expect(output).not.toContain('/home/ada/.codex/x')
    expect(reason(decisions[0])).not.toContain('sk-supersecretvalue123')
  })

  it('returns exit 2 for an unknown adapter without consuming stdin', async () => {
    let read = false
    const { deps, calls, errors, decisions } = harness({
      adapter: 'claude-code',
      readInput: async () => {
        read = true
        return payload()
      },
    })
    const exitCode = await runCodexAgentHookSafely(deps)
    expect(exitCode).toBe(2)
    expect(read).toBe(false)
    expect(calls).toHaveLength(0)
    expect(decisions).toHaveLength(0)
    expect(errors[0]).toContain('only "codex" is supported')
  })

  it('routes a covered Bash call and writes the documented deny at exit 0', async () => {
    const { deps, calls, decisions } = harness()
    const exitCode = await runCodexAgentHookSafely(deps)
    expect(exitCode).toBe(0)
    expect(calls).toHaveLength(1)
    expect(decisions[0]).toBe(
      codexPreToolUseDenyDecision(
        'covered Bash call routed to the selected Session through ocbox exec (exit 0); local execution blocked',
      ),
    )
  })

  it('leaves an uncovered tool local with exit 0 and no writers touched', async () => {
    const { deps, calls, decisions, errors } = harness({
      readInput: async () =>
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          session_id: 'codex-thread-1',
          tool_name: 'Edit',
          tool_input: { command: 'npm test' },
        }),
    })
    const exitCode = await runCodexAgentHookSafely(deps)
    expect(exitCode).toBe(0)
    expect(calls).toHaveLength(0)
    expect(decisions).toHaveLength(0)
    expect(errors).toHaveLength(0)
  })
})

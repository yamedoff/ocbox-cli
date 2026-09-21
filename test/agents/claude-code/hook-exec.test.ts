import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type ClaudeHookDenyDecision,
  runClaudeRoutingHook,
} from '../../../src/agents/claude-code/hook.js'
import { createClaudeHookInvoker } from '../../../src/commands/agent/hook.js'
import { DEFAULT_PROJECT_CONFIG } from '../../../src/cli/runtime.js'
import type { ExecutionWritable } from '../../../src/execution/index.js'

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

function io() {
  return { stdout: new MemoryWritable(), stderr: new MemoryWritable() }
}

function payload(command: string): string {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } })
}

const MISSING_SESSION = '33333333-3333-4333-8333-333333333333'

describe('claude-code hook exec invoker fails closed (N2)', () => {
  it('reports a deleted/unresolvable Session as a pre-start result for the hook to block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocbox-t11-hook-'))
    try {
      const configPath = join(root, 'opencloudbox.toml')
      await writeFile(configPath, DEFAULT_PROJECT_CONFIG, 'utf8')
      const output = io()
      const invoke = createClaudeHookInvoker(
        { config: configPath, 'state-dir': join(root, 'state') },
        output,
      )
      const result = await invoke(['exec', '--session', MISSING_SESSION, '--shell', 'echo hi'])
      expect(result.started).toBe(false)
      expect(result.exitCode).toBe(125)
      expect(output.stderr.text()).toContain('Session')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports an invalid Session id argument as a pre-start result for the hook to block', async () => {
    const output = io()
    const invoke = createClaudeHookInvoker({ 'state-dir': 'unused' }, output)
    const result = await invoke(['exec', '--session', 'sess-1', '--shell', 'echo hi'])
    expect(result.started).toBe(false)
    expect(result.exitCode).toBe(125)
  })

  it('blocks the local tool call with a guard denial through the real hook entrypoint', async () => {
    const output = io()
    const decisions: ClaudeHookDenyDecision[] = []
    const exitCode = await runClaudeRoutingHook({
      rawInput: payload('echo hi'),
      sessionId: 'sess-1',
      environment: {},
      invokeExec: createClaudeHookInvoker({ 'state-dir': 'unused' }, output),
      writeError: () => undefined,
      writeDecision: (decision) => {
        decisions.push(decision)
      },
    })
    expect(exitCode).toBe(2)
    expect(decisions[0]?.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(decisions[0]?.hookSpecificOutput.permissionDecisionReason).toContain(
      'ocbox-block[guard]',
    )
  })
})

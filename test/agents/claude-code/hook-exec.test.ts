import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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

const MISSING_SESSION = '33333333-3333-4333-8333-333333333333'

describe('claude-code hook exec invoker fails closed (N2)', () => {
  it('maps a deleted/unresolvable Session at hook time to blocking exit 2', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocbox-t11-hook-'))
    try {
      const configPath = join(root, 'opencloudbox.toml')
      await writeFile(configPath, DEFAULT_PROJECT_CONFIG, 'utf8')
      const output = io()
      const invoke = createClaudeHookInvoker(
        { config: configPath, 'state-dir': join(root, 'state') },
        output,
      )
      const exitCode = await invoke(['exec', '--session', MISSING_SESSION, '--shell', 'echo hi'])
      expect(exitCode).toBe(2)
      expect(output.stderr.text()).toContain('Session')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('maps an invalid Session id argument to blocking exit 2', async () => {
    const output = io()
    const invoke = createClaudeHookInvoker({ 'state-dir': 'unused' }, output)
    const exitCode = await invoke(['exec', '--session', 'sess-1', '--shell', 'echo hi'])
    expect(exitCode).toBe(2)
  })
})

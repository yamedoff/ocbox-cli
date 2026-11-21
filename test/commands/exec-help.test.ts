import { describe, expect, it } from 'vitest'
import Exec from '../../src/commands/exec.js'
import Pause from '../../src/commands/pause.js'
import SyncDiff from '../../src/commands/sync/diff.js'
import SyncPull from '../../src/commands/sync/pull.js'
import SyncRecover from '../../src/commands/sync/recover.js'

function flagDescription(
  Command: { readonly flags: Record<string, unknown> },
  flag: string,
): string {
  const definition = Command.flags[flag] as { readonly description?: string } | undefined
  return definition?.description ?? ''
}

describe('exec help', () => {
  it('shows the argv placeholder and the workspace default in the description', () => {
    expect(Exec.usage).toBe('exec [flags] -- <command> [args...]')
    const lines = (Exec.description ?? '').split('\n')
    expect(lines[0]).toContain('ocbox exec -- npm test')
    expect(Exec.description).toContain("box's workspace folder")
    expect(Exec.description).toContain('ocbox sync push')
  })

  it('states the timeout unit with an example for both flags', () => {
    expect(flagDescription(Exec, 'timeout')).toContain('milliseconds')
    expect(flagDescription(Exec, 'timeout')).toContain('--timeout 300000')
    expect(flagDescription(Exec, 'timeout-seconds')).toContain('seconds')
    expect(flagDescription(Exec, 'timeout-seconds')).toContain('--timeout-seconds 300')
    expect(flagDescription(Exec, 'timeout-seconds')).toContain('timeoutSeconds')
  })
})

describe('hosted refusals in command help', () => {
  it('names the hosted refusal and the alternative for exec --cwd and --env', () => {
    for (const [flag, alternative] of [
      ['cwd', 'box workspace'],
      ['env', 'command or image'],
    ] as const) {
      const description = flagDescription(Exec, flag)
      expect(description).toContain('hosted service refuses this flag')
      expect(description).toContain(alternative)
    }
  })

  it('says pause is refused on hosted and points at stop', () => {
    expect(Pause.description).toContain('hosted service refuses pause')
    expect(Pause.description).toContain('ocbox stop')
  })

  it('names the hosted refusal and the alternative for sync --remote-dir', () => {
    for (const Command of [SyncPull, SyncDiff, SyncRecover]) {
      const description = flagDescription(Command, 'remote-dir')
      expect(description).toContain('hosted service refuses this flag')
      expect(description).toContain('omit it')
    }
  })
})

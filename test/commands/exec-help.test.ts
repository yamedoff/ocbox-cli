import { describe, expect, it } from 'vitest'
import Exec from '../../src/commands/exec.js'

describe('exec help', () => {
  it('shows the argv placeholder and the workspace default in the description', () => {
    expect(Exec.usage).toBe('exec [flags] -- <command> [args...]')
    const lines = (Exec.description ?? '').split('\n')
    expect(lines[0]).toContain('ocbox exec -- npm test')
    expect(Exec.description).toContain("box's workspace folder")
    expect(Exec.description).toContain('ocbox sync push')
  })
})

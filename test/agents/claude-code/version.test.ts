import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_CODE_PINNED_VERSION,
  CLAUDE_CODE_SETTINGS_SCHEMA_REVISION,
  detectClaudeCodeVersion,
  gateClaudeVersion,
  parseClaudeCodeVersion,
  PINNED_CLAUDE_CODE_VERSION,
  parseClaudeVersionOutput,
  settingsSchemaRevisionFor,
} from '../../../src/agents/claude-code/version.js'

describe('claude-code version gate', () => {
  it('pins the locally verified version', () => {
    expect(PINNED_CLAUDE_CODE_VERSION).toBe('2.0.51')
  })

  it('accepts the exact pinned version output', () => {
    const parsed = parseClaudeVersionOutput('2.0.51 (Claude Code)')
    expect(parsed.version).toBe('2.0.51')
    expect(parsed.supported).toBe(true)
    expect(gateClaudeVersion('2.0.51 (Claude Code)').supported).toBe(true)
  })

  it('fails closed on unknown versions with remediation', () => {
    for (const raw of ['2.1.39 (Claude Code)', '1.0.0 (Claude Code)', '', 'garbage']) {
      const gate = gateClaudeVersion(raw)
      expect(gate.supported).toBe(false)
      expect(gate.remediation).toContain('2.0.51')
      expect(gate.remediation).toContain('fails closed')
    }
  })

  it('never invents schema support for adjacent versions', () => {
    expect(gateClaudeVersion('2.0.52 (Claude Code)').supported).toBe(false)
    expect(gateClaudeVersion('2.0.50 (Claude Code)').supported).toBe(false)
  })

  it('matches the committed base fixture shape', async () => {
    const raw = await readFile(
      new URL('../../fixtures/claude-code/base-settings.json', import.meta.url),
      'utf8',
    )
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed['alwaysThinkingEnabled']).toBe(true)
    expect(Array.isArray((parsed['permissions'] as Record<string, unknown>)['deny'])).toBe(true)
  })

  it('exposes a throwing detector over the same pin', () => {
    expect(CLAUDE_CODE_PINNED_VERSION).toBe(PINNED_CLAUDE_CODE_VERSION)
    expect(parseClaudeCodeVersion('2.0.51 (Claude Code)')).toBe('2.0.51')
    expect(detectClaudeCodeVersion('2.0.51 (Claude Code)').version).toBe('2.0.51')
    expect(settingsSchemaRevisionFor('2.0.51')).toBe(CLAUDE_CODE_SETTINGS_SCHEMA_REVISION)
    expect(() => parseClaudeCodeVersion('garbage')).toThrow()
    expect(() => detectClaudeCodeVersion('2.0.52 (Claude Code)')).toThrow()
  })
})

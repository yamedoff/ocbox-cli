import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  assertClaudeVersionOverrideAllowed,
  CLAUDE_CODE_PINNED_SURFACE_EVIDENCE,
  CLAUDE_CODE_PINNED_SURFACE_FIXTURE,
  CLAUDE_CODE_PINNED_VERSION,
  CLAUDE_CODE_SETTINGS_SCHEMA_REVISION,
  CLAUDE_HOOK_EVENTS,
  CLAUDE_TOOL_MATCHERS,
  detectClaudeCodeVersion,
  gateClaudeVersion,
  parseClaudeCodeVersion,
  PINNED_CLAUDE_CODE_VERSION,
  parseClaudeVersionOutput,
  settingsSchemaRevisionFor,
  TEST_HARNESS_ENV,
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

  it('rejects prerelease and non-leading version output', () => {
    for (const raw of [
      '2.0.51-beta.1 (Claude Code)',
      '2.0.51-rc.1',
      '2.0.51.1 (Claude Code)',
      'claude-code 2.0.51 (Claude Code)',
      'v2.0.51',
    ]) {
      const parsed = parseClaudeVersionOutput(raw)
      expect(parsed.supported).toBe(false)
      expect(gateClaudeVersion(raw).supported).toBe(false)
      expect(() => parseClaudeCodeVersion(raw)).toThrow()
      expect(() => detectClaudeCodeVersion(raw)).toThrow()
    }
  })

  it('restricts the version override to the explicit test harness', () => {
    expect(TEST_HARNESS_ENV).toBe('OCBOX_TEST_MODE')
    expect(() => assertClaudeVersionOverrideAllowed(undefined, {})).not.toThrow()
    expect(() => assertClaudeVersionOverrideAllowed('2.0.51 (Claude Code)', {})).toThrow(
      /test harness/,
    )
    expect(() =>
      assertClaudeVersionOverrideAllowed('2.0.51 (Claude Code)', {
        [TEST_HARNESS_ENV]: '1',
      }),
    ).not.toThrow()
  })

  it('exposes a throwing detector over the same pin', () => {
    expect(CLAUDE_CODE_PINNED_VERSION).toBe(PINNED_CLAUDE_CODE_VERSION)
    expect(parseClaudeCodeVersion('2.0.51 (Claude Code)')).toBe('2.0.51')
    expect(detectClaudeCodeVersion('2.0.51 (Claude Code)').version).toBe('2.0.51')
    expect(settingsSchemaRevisionFor('2.0.51')).toBe(CLAUDE_CODE_SETTINGS_SCHEMA_REVISION)
    expect(() => parseClaudeCodeVersion('garbage')).toThrow()
    expect(() => detectClaudeCodeVersion('2.0.52 (Claude Code)')).toThrow()
  })

  it('keeps one evidence-labeled pinned surface matching its fixture', async () => {
    const raw = await readFile(
      new URL('../../fixtures/claude-code/pinned-surface.json', import.meta.url),
      'utf8',
    )
    const fixture = JSON.parse(raw) as {
      readonly pinnedVersion: string
      readonly settingsSchemaRevision: number
      readonly evidence: string
      readonly hookEvents: readonly string[]
      readonly toolMatchers: readonly string[]
    }
    expect(fixture.pinnedVersion).toBe(PINNED_CLAUDE_CODE_VERSION)
    expect(fixture.settingsSchemaRevision).toBe(CLAUDE_CODE_SETTINGS_SCHEMA_REVISION)
    expect(fixture.evidence.length).toBeGreaterThan(0)
    expect([...CLAUDE_HOOK_EVENTS]).toEqual([...fixture.hookEvents])
    expect([...CLAUDE_TOOL_MATCHERS]).toEqual([...fixture.toolMatchers])
    expect(CLAUDE_CODE_PINNED_SURFACE_FIXTURE).toBe('test/fixtures/claude-code/pinned-surface.json')
    expect(CLAUDE_CODE_PINNED_SURFACE_EVIDENCE.fixture).toBe(CLAUDE_CODE_PINNED_SURFACE_FIXTURE)
    expect(CLAUDE_CODE_PINNED_SURFACE_EVIDENCE.label).toContain(PINNED_CLAUDE_CODE_VERSION)
    expect(CLAUDE_CODE_PINNED_SURFACE_EVIDENCE.note).toContain('live-only gate')
  })
})

import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SETTINGS_PRECEDENCE,
  higherPrecedenceSources,
  precedenceRank,
  resolveClaudeSettingsLayout,
  resolveClaudeSettingsSources,
  targetPathForScope,
} from '../../../src/agents/claude-code/settings-sources.js'

describe('claude-code settings sources', () => {
  it('orders precedence managed > local > shared > user', () => {
    const layout = resolveClaudeSettingsLayout({
      homeDirectory: '/tmp/home',
      projectDirectory: '/tmp/proj',
      platformOverride: 'linux',
    })
    expect([...layout.precedenceHighToLow]).toEqual([
      'managed',
      'local-project',
      'shared-project',
      'user',
    ])
  })

  it('resolves user and project paths without touching real settings', () => {
    const layout = resolveClaudeSettingsLayout({
      homeDirectory: '/tmp/fake-home',
      projectDirectory: '/tmp/fake-proj',
      platformOverride: 'win32',
      managedPathOverride: null,
    })
    expect(layout.userSettingsPath).toContain('fake-home')
    expect(layout.sharedProjectSettingsPath).toContain('fake-proj')
    expect(layout.localProjectSettingsPath).toContain('settings.local.json')
    expect(layout.managedSettingsPath).toBeNull()
  })

  it('maps scopes to distinct owned targets', () => {
    const layout = resolveClaudeSettingsLayout({
      homeDirectory: '/h',
      projectDirectory: '/p',
      platformOverride: 'linux',
    })
    const user = targetPathForScope(layout, 'user')
    const project = targetPathForScope(layout, 'project')
    const local = targetPathForScope(layout, 'local')
    expect(new Set([user, project, local]).size).toBe(3)
    expect(project).toContain('.claude')
    expect(local).toContain('settings.local.json')
  })

  it('exposes platform managed paths per OS', () => {
    const linux = resolveClaudeSettingsLayout({
      homeDirectory: '/h',
      projectDirectory: '/p',
      platformOverride: 'linux',
    })
    expect(linux.managedSettingsPath).toBe('/etc/claude-code/managed-settings.json')
    const mac = resolveClaudeSettingsLayout({
      homeDirectory: '/h',
      projectDirectory: '/p',
      platformOverride: 'darwin',
    })
    expect(mac.managedSettingsPath).toBe(
      '/Library/Application Support/ClaudeCode/managed-settings.json',
    )
  })

  it('inserts the explicit overlay between managed and local-project', () => {
    const layout = resolveClaudeSettingsLayout({
      homeDirectory: '/h',
      projectDirectory: '/p',
      platformOverride: 'linux',
      explicitPaths: ['/tmp/explicit.json'],
    })
    expect([...layout.precedenceHighToLow]).toEqual([
      'managed',
      'explicit',
      'local-project',
      'shared-project',
      'user',
    ])
    expect([...CLAUDE_SETTINGS_PRECEDENCE]).toEqual([...layout.precedenceHighToLow])
    const sources = resolveClaudeSettingsSources(layout)
    expect(sources.map((source) => source.kind)).toEqual([
      'managed',
      'explicit',
      'local-project',
      'shared-project',
      'user',
    ])
    const explicit = sources.find((source) => source.kind === 'explicit')
    expect(explicit?.writableByAdapter).toBe(false)
    expect(precedenceRank('managed')).toBeLessThan(precedenceRank('explicit'))
    expect(precedenceRank('explicit')).toBeLessThan(precedenceRank('local-project'))
  })

  it('never lets a lower source weaken higher policy', () => {
    const layout = resolveClaudeSettingsLayout({
      homeDirectory: '/h',
      projectDirectory: '/p',
      platformOverride: 'linux',
      explicitPaths: ['/tmp/explicit.json'],
    })
    const sources = resolveClaudeSettingsSources(layout)
    const higher = higherPrecedenceSources(sources, 'shared-project')
    expect(higher.map((source) => source.kind)).toEqual(['managed', 'explicit', 'local-project'])
    const writable = sources.filter((source) => source.writableByAdapter)
    expect(writable.map((source) => source.kind)).toEqual([
      'local-project',
      'shared-project',
      'user',
    ])
  })
})

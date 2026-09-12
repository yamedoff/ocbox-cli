import { describe, expect, it } from 'vitest'
import {
  resolveClaudeSettingsLayout,
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
})

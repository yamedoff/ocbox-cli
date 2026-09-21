import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { planMerge, planRemove } from '../../../src/agents/claude-code/merge.js'
import { buildHookCommand } from '../../../src/agents/claude-code/routing.js'
import {
  collectDenyAskRules,
  hasManagedHookLock,
  hookEntryOwned,
  parseSettingsJson,
} from '../../../src/agents/claude-code/settings-model.js'

describe('claude-code settings model and merge', () => {
  it('rejects array matchers as schema errors instead of matching silently', async () => {
    const raw = await readFile(
      new URL('../../fixtures/claude-code/corrupt-settings.json', import.meta.url),
      'utf8',
    )
    const parsed = parseSettingsJson('/tmp/settings.json', raw)
    expect(parsed.issues.length).toBeGreaterThan(0)
    expect(parsed.issues.some((issue) => issue.message.includes('single string'))).toBe(true)
  })

  it('rejects invalid JSON and non-object roots fail-closed', () => {
    expect(parseSettingsJson('/p', 'not json').issues.length).toBeGreaterThan(0)
    expect(parseSettingsJson('/p', '[]').issues.length).toBeGreaterThan(0)
  })

  it('preserves unrelated keys and arrays while adding owned entries', async () => {
    const raw = await readFile(
      new URL('../../fixtures/claude-code/base-settings.json', import.meta.url),
      'utf8',
    )
    const parsed = parseSettingsJson('/tmp/settings.json', raw)
    expect(parsed.issues).toEqual([])
    const merged = planMerge(parsed.document, 'sess-1')
    expect(merged.addedHook).toBe(true)
    expect(merged.addedPermission).toBe(true)
    const document = merged.document as Record<string, unknown>
    expect(document['alwaysThinkingEnabled']).toBe(true)
    expect(document['statusLine']).toBeDefined()
    const permissions = document['permissions'] as Record<string, unknown>
    expect(permissions['deny']).toContain('Bash(rm -rf *)')
    expect(permissions['ask']).toContain('Read(./secrets/**)')
    expect(permissions['allow']).toContain('Bash(npm test *)')
    expect(permissions['allow']).toContain('Bash(ocbox exec:*)')
    const hooks = document['hooks'] as Record<string, unknown[]>
    expect(Array.isArray(hooks['PreToolUse'])).toBe(true)
    expect(hooks['PreToolUse']?.some(hookEntryOwned)).toBe(true)
  })

  it('keeps merge idempotent on repeat runs', async () => {
    const raw = await readFile(
      new URL('../../fixtures/claude-code/base-settings.json', import.meta.url),
      'utf8',
    )
    const first = planMerge(parseSettingsJson('/tmp/s.json', raw).document, 'sess-1')
    const second = planMerge(first.document, 'sess-1')
    expect(second.alreadyApplied).toBe(true)
    expect(JSON.stringify(second.document)).toBe(JSON.stringify(first.document))
  })

  it('removes only owned matches and preserves user edits', async () => {
    const raw = await readFile(
      new URL('../../fixtures/claude-code/base-settings.json', import.meta.url),
      'utf8',
    )
    const merged = planMerge(parseSettingsJson('/tmp/s.json', raw).document, 'sess-1')
    const editable = JSON.parse(JSON.stringify(merged.document)) as Record<string, unknown>
    editable['myCustomKey'] = 'user-edit'
    const removed = planRemove(editable)
    expect(removed.removedHooks).toBe(1)
    expect(removed.removedPermissions).toBe(1)
    const document = removed.document as Record<string, unknown>
    expect(document['myCustomKey']).toBe('user-edit')
    expect(document['alwaysThinkingEnabled']).toBe(true)
    const hooks = document['hooks'] as Record<string, unknown[]>
    expect(hooks['PreToolUse']?.some(hookEntryOwned)).toBe(false)
  })

  it('preserves deny and ask rules and detects managed locks', async () => {
    const raw = await readFile(
      new URL('../../fixtures/claude-code/managed-settings.json', import.meta.url),
      'utf8',
    )
    const managed = parseSettingsJson('/etc/managed.json', raw)
    expect(managed.issues).toEqual([])
    const { deny } = collectDenyAskRules(managed.document)
    expect(deny).toContain('Read(./.env)')
    expect(hasManagedHookLock({ allowManagedHooksOnly: true })).toBe(true)
    expect(hasManagedHookLock({ permissions: { allowManagedPermissionRulesOnly: true } })).toBe(
      true,
    )
    expect(hasManagedHookLock(managed.document)).toBe(false)
  })

  it('never weakens higher-precedence deny rules (protected, not written)', async () => {
    const raw = await readFile(
      new URL('../../fixtures/claude-code/base-settings.json', import.meta.url),
      'utf8',
    )
    const parsed = parseSettingsJson('/tmp/s.json', raw)
    const merged = planMerge(parsed.document, 'sess-1', {
      higherDeny: ['Bash(ocbox exec:*)'],
    })
    expect(merged.addedPermission).toBe(false)
    expect(merged.protectedRules).toContain('Bash(ocbox exec:*)')
    const permissions = merged.document.permissions as Record<string, unknown>
    expect(permissions['deny']).toContain('Bash(rm -rf *)')
  })

  it('treats read-only sources as protected without mutating', () => {
    const merged = planMerge({}, 'sess-1', { readOnlySource: true })
    expect(merged.changed).toBe(false)
    expect(merged.alreadyApplied).toBe(true)
    expect(merged.protectedRules.length).toBeGreaterThan(0)
    expect(merged.document).toEqual({})
  })

  it('tracks created pointers and prunes them on remove', () => {
    const merged = planMerge({}, 'sess-1')
    expect(merged.createdPointers).toContain('/hooks')
    expect(merged.createdPointers).toContain('/permissions')
    const removed = planRemove(merged.document, merged.createdPointers)
    expect(removed.removedHooks).toBe(1)
    expect(removed.removedPermissions).toBe(1)
    expect(removed.document).toEqual({})
  })

  it('removes only adapter-owned hook objects from a mixed matcher entry (H5)', () => {
    const userHook = { type: 'command', command: '/home/user/my-own-hook.sh' }
    const document = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: buildHookCommand('sess-1') }, userHook],
          },
        ],
      },
    }
    const removed = planRemove(document)
    expect(removed.removedHooks).toBe(1)
    const hooks = (removed.document as Record<string, unknown>)['hooks'] as Record<
      string,
      unknown[]
    >
    const entries = hooks['PreToolUse'] as Array<Record<string, unknown>>
    expect(entries).toHaveLength(1)
    expect(entries[0]?.['matcher']).toBe('Bash')
    expect(entries[0]?.['hooks']).toEqual([userHook])
  })

  it('never treats a user command that mentions owned fragments as adapter-owned (H5)', () => {
    const userCommand = 'echo "ocbox exec ocbox-claude-code"'
    const entry = { matcher: 'Bash', hooks: [{ type: 'command', command: userCommand }] }
    expect(hookEntryOwned(entry)).toBe(false)
    const removed = planRemove({ hooks: { PreToolUse: [entry] } })
    expect(removed.removedHooks).toBe(0)
    const hooks = (removed.document as Record<string, unknown>)['hooks'] as Record<
      string,
      unknown[]
    >
    expect((hooks['PreToolUse'] as Array<Record<string, unknown>>)[0]?.['hooks']).toEqual([
      { type: 'command', command: userCommand },
    ])
  })

  it('restores exact user content without synthesizing deny/ask arrays (H6)', () => {
    const original = {
      alwaysThinkingEnabled: true,
      permissions: { allow: ['Bash(npm test *)'] },
      custom: { nested: [1, 2, 3] },
    }
    const merged = planMerge(original, 'sess-1')
    const permissions = merged.document['permissions'] as Record<string, unknown>
    expect(permissions['deny']).toBeUndefined()
    expect(permissions['ask']).toBeUndefined()
    const removed = planRemove(merged.document, merged.createdPointers)
    expect(removed.document).toEqual(original)
  })

  it('rotates an installed Session in place instead of silently retaining it (H9)', () => {
    const first = planMerge({}, 'sess-1')
    expect(first.installedSessionId).toBeNull()
    const rotated = planMerge(first.document, 'sess-2')
    expect(rotated.alreadyApplied).toBe(false)
    expect(rotated.sessionChanged).toBe(true)
    expect(rotated.addedHook).toBe(false)
    expect(rotated.addedPermission).toBe(false)
    expect(rotated.installedSessionId).toBe('sess-1')
    const document = rotated.document as unknown as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }
    }
    const installed = document.hooks.PreToolUse[0]?.hooks[0]?.command
    expect(installed).toContain('--session sess-2')
    expect(installed).not.toContain('--session sess-1')
  })

  it('reports container-invalid conflicts instead of overwriting user types', () => {
    const document = {
      hooks: { PreToolUse: 'not-an-array' },
      permissions: { allow: 'not-an-array' },
    }
    const merged = planMerge(document, 'sess-1')
    expect(merged.protectedRules).toContain('/hooks/PreToolUse')
    expect(merged.protectedRules).toContain('/permissions/allow')
    const removed = planRemove(document)
    expect(removed.conflicts.map((conflict) => conflict.pointer)).toContain('/hooks/PreToolUse')
    expect(removed.conflicts.map((conflict) => conflict.pointer)).toContain('/permissions/allow')
  })
})

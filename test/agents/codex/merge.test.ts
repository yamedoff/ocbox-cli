import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  parseHooksJsonDocument,
  parseTomlDocument,
  serializeHooksJsonDocument,
  serializeTomlDocument,
} from '../../../src/agents/codex/codec.js'
import { CodexAdapterError } from '../../../src/agents/codex/errors.js'
import { detectCodexSchema, validateHooksTable } from '../../../src/agents/codex/schema.js'
import {
  ensureGroup,
  eventGroups,
  pruneEmptyHooksTable,
  readHooksTable,
  removeGroup,
  toOwnedFragment,
  type CodexDesiredFragment,
} from '../../../src/agents/codex/hooks.js'
import { deepEqual } from '../../../src/agents/codex/document.js'
import { buildHookCommand } from '../../../src/agents/codex/hook-helper.js'
import { CODEX_HOOK_MATCHER_TOOL } from '../../../src/agents/codex/hook-contract.js'

const VERSION_OUTPUT = 'codex-cli 0.153.4'

function desiredSessionFragment(sessionId: string): CodexDesiredFragment {
  return {
    event: 'PreToolUse',
    matcher: CODEX_HOOK_MATCHER_TOOL,
    group: {
      matcher: CODEX_HOOK_MATCHER_TOOL,
      hooks: [{ type: 'command', command: buildHookCommand({ sessionId }) }],
    },
  }
}

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../../fixtures/agents/codex/${name}`, import.meta.url), 'utf8')
}

describe('codex schema gate', () => {
  it('accepts the pinned schema and enumerates the hook events', () => {
    const schema = detectCodexSchema(VERSION_OUTPUT, { config: null, hooks: null })
    expect(schema.revision).toBe('codex-cli-0.153')
    expect(schema.representations).toEqual(['config-toml', 'hooks-json'])
  })

  it('fails closed on an unknown hook event', () => {
    expect(() =>
      detectCodexSchema(VERSION_OUTPUT, { config: { hooks: { FutureEvent: [] } }, hooks: null }),
    ).toThrow(CodexAdapterError)
  })

  it('fails closed when an event value is not an array', () => {
    expect(() => validateHooksTable({ PreToolUse: 'nope' }, 'config.toml')).toThrow(
      CodexAdapterError,
    )
  })
})

describe('codex lossless hooks-table merge', () => {
  it('adds the owned group to hooks.json without touching the user config', async () => {
    const configToml = await fixture('user-config.toml')
    const config = parseTomlDocument(configToml)
    expect(config?.['model']).toBe('gpt-5.6-luna')
    const owned = toOwnedFragment(desiredSessionFragment('sess-test-1'))
    const target: Record<string, unknown> = {}
    const table: Record<string, unknown> = {}
    target['hooks'] = table
    expect(ensureGroup(table, owned)).toBe(true)
    expect(ensureGroup(table, owned)).toBe(false)
    expect(eventGroups(table, 'PreToolUse')).toEqual([owned.group])
    const serialized = serializeHooksJsonDocument(target)
    expect(parseHooksJsonDocument(serialized)?.['hooks']).toEqual({
      PreToolUse: [owned.group],
    })
  })

  it('merges into an existing config.toml hooks table, preserving user hooks exactly', async () => {
    const configToml = await fixture('config-with-user-hooks.toml')
    const config = parseTomlDocument(configToml) ?? {}
    const owned = toOwnedFragment(desiredSessionFragment('sess-test-1'))
    const table = readHooksTable(config)
    expect(table).not.toBeNull()
    if (table === null) throw new Error('fixture has no hooks table')
    expect(ensureGroup(table, owned)).toBe(true)
    const merged = config['hooks'] as Record<string, unknown>
    expect(Object.keys(merged).sort()).toEqual(['PreToolUse', 'SessionStart'])
    expect(merged['SessionStart']).toEqual([
      { matcher: 'startup', hooks: [{ type: 'command', command: 'existing-user-hook' }] },
    ])
    expect(serializeTomlDocument(config)).toContain('existing-user-hook')
  })

  it('removes only the owned group and prunes the empty table', () => {
    const owned = toOwnedFragment(desiredSessionFragment('sess-test-1'))
    const document: Record<string, unknown> = { model: 'x', hooks: { PreToolUse: [owned.group] } }
    const table = readHooksTable(document)
    expect(table).not.toBeNull()
    if (table === null) throw new Error('expected hooks table')
    expect(removeGroup(table, owned)).toBe(true)
    pruneEmptyHooksTable(document)
    expect(document['hooks']).toBeUndefined()
    expect(document['model']).toBe('x')
  })

  it('keeps unrelated groups byte-stable across merge then strip', async () => {
    const configToml = await fixture('config-with-user-hooks.toml')
    const before = parseTomlDocument(configToml) ?? {}
    const owned = toOwnedFragment(desiredSessionFragment('sess-test-1'))
    const table = readHooksTable(before)
    if (table === null) throw new Error('fixture has no hooks table')
    ensureGroup(table, owned)
    expect(removeGroup(table, owned)).toBe(true)
    pruneEmptyHooksTable(before)
    expect(deepEqual(before, parseTomlDocument(configToml))).toBe(true)
  })

  it('refuses corrupted documents instead of guessing', () => {
    expect(() => parseTomlDocument('model = [unterminated')).toThrow(CodexAdapterError)
    expect(() => parseHooksJsonDocument('[1,')).toThrow(CodexAdapterError)
  })
})

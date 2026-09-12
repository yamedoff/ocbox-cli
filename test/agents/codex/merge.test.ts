import { describe, expect, it } from 'vitest'
import {
  FIXTURE_TOML_SCHEMA,
  inlineHooksPresent,
  mergeOwnedToml,
  ownedTomlFragment,
  parseCodexToml,
  readOwnedToml,
  serializeCodexToml,
  stripOwnedToml,
} from '../../../src/agents/codex/toml-merge.js'
import {
  buildOwnedHookEntry,
  hasOwnedHook,
  mergeOwnedHooks,
  parseHooksJson,
  removeOwnedHooks,
  serializeHooksJson,
} from '../../../src/agents/codex/hooks-file.js'
import { buildHookArgv, HOOK_OWNED_ID } from '../../../src/agents/codex/hook-helper.js'

const BASE_CONFIG = [
  'model = "gpt-5.6-luna"',
  'approval_policy = "never"',
  '',
  '[mcp_servers.context7]',
  'url = "https://mcp.context7.com/mcp"',
  '',
  '[projects."C:\\\\Users\\\\boudi\\\\Desktop\\\\replica"]',
  'trust_level = "trusted"',
  '',
].join('\n')

function fragment() {
  return ownedTomlFragment({
    adapterVersion: 'ocbox-codex-adapter-v1',
    codexVersion: '0.153.4',
    layer: 'user',
    sessionId: 'sess-test-1',
    hookId: HOOK_OWNED_ID,
    hookRepresentation: 'hooks-json',
  })
}

describe('codex toml merge', () => {
  it('preserves unrelated settings across a golden merge', () => {
    const merged = serializeCodexToml(mergeOwnedToml(parseCodexToml(BASE_CONFIG), fragment()))
    const document = parseCodexToml(merged)
    expect(document['model']).toBe('gpt-5.6-luna')
    expect(document['approval_policy']).toBe('never')
    expect(document['mcp_servers']).toMatchObject({
      context7: { url: 'https://mcp.context7.com/mcp' },
    })
    expect(document['projects']).toMatchObject({
      'C:\\Users\\boudi\\Desktop\\replica': { trust_level: 'trusted' },
    })
    expect(readOwnedToml(document)).toMatchObject({
      codex: { fixture: FIXTURE_TOML_SCHEMA, sessionId: 'sess-test-1', layer: 'user' },
    })
  })

  it('round-trips merge then strip to the original document', () => {
    const base = parseCodexToml(BASE_CONFIG)
    const merged = mergeOwnedToml(base, fragment())
    expect(stripOwnedToml(merged)).toEqual(base)
  })

  it('is byte-stable across repeated merges', () => {
    const first = serializeCodexToml(mergeOwnedToml(parseCodexToml(BASE_CONFIG), fragment()))
    const second = serializeCodexToml(mergeOwnedToml(parseCodexToml(first), fragment()))
    expect(second).toBe(first)
  })

  it('refuses corrupted TOML instead of guessing', () => {
    expect(() => parseCodexToml('model = [unclosed')).toThrow(/refusing to merge/)
  })

  it('detects inline hook representations', () => {
    expect(inlineHooksPresent(parseCodexToml(`${BASE_CONFIG}\n[hooks]\ntest = 1\n`))).toBe(true)
    expect(inlineHooksPresent(parseCodexToml(BASE_CONFIG))).toBe(false)
  })
})

describe('codex hooks file merge', () => {
  const owned = buildOwnedHookEntry('sess-test-1', buildHookArgv({ sessionId: 'sess-test-1' }))

  it('appends the owned entry while preserving foreign hooks', () => {
    const existing = parseHooksJson(
      '{"schemaVersion":1,"fixture":"x","hooks":[{"id":"other","command":["run"],"matcher":"shell","sessionId":"","sync":"explicit"}]}',
    )
    const merged = mergeOwnedHooks(existing, owned)
    expect(merged.hooks).toHaveLength(2)
    expect(hasOwnedHook(merged)).toBe(true)
    expect(serializeHooksJson(merged)).toContain(HOOK_OWNED_ID)
  })

  it('replaces the owned entry idempotently on repeat merges', () => {
    const once = mergeOwnedHooks(null, owned)
    const twice = mergeOwnedHooks(once, owned)
    expect(twice).toEqual(once)
    expect(twice.hooks).toHaveLength(1)
  })

  it('removes only the owned entry', () => {
    const existing = parseHooksJson(
      '{"schemaVersion":1,"fixture":"x","hooks":[{"id":"other","command":[],"matcher":"shell","sessionId":"","sync":"explicit"}]}',
    )
    const merged = mergeOwnedHooks(existing, owned)
    const { document, removed } = removeOwnedHooks(merged)
    expect(removed).toBe(true)
    expect(document.hooks).toHaveLength(1)
    expect(hasOwnedHook(document)).toBe(false)
  })

  it('refuses corrupted hooks JSON', () => {
    expect(() => parseHooksJson('{oops')).toThrow(/refusing to merge/)
    expect(() => parseHooksJson('{"schemaVersion":1}')).toThrow(/hooks array/)
  })
})

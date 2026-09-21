import { describe, expect, it } from 'vitest'
import * as adapter from '../../../src/agents/claude-code/index.js'
import * as settingsModel from '../../../src/agents/claude-code/settings-model.js'
import * as routing from '../../../src/agents/claude-code/routing.js'

// The ownership grammar must have exactly one implementation. `routing.ts` and
// the adapter barrel re-export the `settings-model.ts` parser by reference, so a
// future copy-paste definition would make these identity checks fail (L6).
describe('claude-code ownership parser single source of truth (L6)', () => {
  it('exposes the same parser reference from routing, the barrel, and settings-model', () => {
    expect(routing.parseOwnedHookCommand).toBe(settingsModel.parseOwnedHookCommand)
    expect(adapter.parseOwnedHookCommand).toBe(settingsModel.parseOwnedHookCommand)
    expect(routing.isOwnedHookCommand).toBe(settingsModel.isOwnedHookCommand)
    expect(adapter.isOwnedHookCommand).toBe(settingsModel.isOwnedHookCommand)
  })

  it('classifies a shared corpus identically through every consumer', () => {
    const corpus: readonly unknown[] = [
      'ocbox agent hook claude-code',
      'ocbox agent hook claude-code --session sess-9',
      'ocbox agent hook claude-code --session 11111111-1111-4111-8111-111111111111',
      'ocbox agent hook claude-code --session sess-9 extra',
      'echo ocbox agent hook claude-code',
      'ocbox agent hook claude-code  --session sess-9',
      ' ocbox agent hook claude-code',
      'ocbox agent hook claude-code ',
      '',
      null,
      42,
      ['ocbox agent hook claude-code'],
    ]
    for (const command of corpus) {
      const expected = settingsModel.parseOwnedHookCommand(command)
      expect(routing.parseOwnedHookCommand(command), String(command)).toEqual(expected)
      expect(adapter.parseOwnedHookCommand(command), String(command)).toEqual(expected)
      expect(routing.isOwnedHookCommand(command)).toBe(expected !== null)
      expect(adapter.isOwnedHookCommand(command)).toBe(expected !== null)
    }
  })

  it('does not re-expose the removed spoofable marker constant (L2)', () => {
    expect(Object.hasOwn(adapter, 'OWNED_MARKER')).toBe(false)
    expect(Object.hasOwn(settingsModel, 'OWNED_MARKER')).toBe(false)
  })
})

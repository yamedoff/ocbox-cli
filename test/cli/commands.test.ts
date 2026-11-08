import { describe, expect, it } from 'vitest'
import ListSessions from '../../src/commands/ls.js'

describe('session listing command', () => {
  it('exposes --all to include destroyed Sessions', () => {
    expect(ListSessions.flags).toHaveProperty('all')
  })
})

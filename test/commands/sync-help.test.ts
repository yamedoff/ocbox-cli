import { describe, expect, it } from 'vitest'
import SyncDiff from '../../src/commands/sync/diff.js'
import SyncTopic, { SYNC_USAGE } from '../../src/commands/sync/index.js'
import SyncPull from '../../src/commands/sync/pull.js'
import SyncPush from '../../src/commands/sync/push.js'

const OLD_WARNING = 'Hosted boxes support sync push only'

describe('sync help', () => {
  it('describes hosted pull and diff instead of warning that they are unfinished', () => {
    for (const text of [
      SYNC_USAGE,
      SyncTopic.description,
      SyncPush.description,
      SyncPull.description,
      SyncDiff.description,
    ]) {
      expect(text).not.toContain(OLD_WARNING)
      expect(text).toContain('hosted')
    }
  })
})

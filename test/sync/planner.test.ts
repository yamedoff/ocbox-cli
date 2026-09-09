import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { UtcTimestampSchema } from '../../src/domain/timestamps.js'
import {
  type SyncSnapshotEntry,
  SyncSnapshotEntrySchema,
  snapshotSha256,
  type VerifiedSyncBaseline,
} from '../../src/sync/baseline.js'
import { normalizeManifestPath } from '../../src/sync/path-policy.js'
import { planSync } from '../../src/sync/planner.js'

function file(path: string, contents: string): SyncSnapshotEntry {
  return SyncSnapshotEntrySchema.parse({
    path: normalizeManifestPath(path),
    type: 'file',
    size: Buffer.byteLength(contents),
    sha256: createHash('sha256').update(contents).digest('hex'),
    mode: 0o640,
    linkTarget: null,
  })
}

function verified(entries: readonly SyncSnapshotEntry[]): VerifiedSyncBaseline {
  const sorted = [...entries].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  )
  return {
    schemaVersion: 1,
    verified: true,
    verifiedAt: UtcTimestampSchema.parse('2026-09-10T00:00:00.000Z'),
    snapshotSha256: snapshotSha256(sorted),
    entries: sorted,
  }
}

describe('three-way sync planner', () => {
  it('allows a first push only into an empty remote workspace', () => {
    const source = [file('a.txt', 'one')]
    const allowed = planSync({ mode: 'push', local: source, remote: [], baseline: null })
    expect(allowed.conflicts).toEqual([])
    expect(allowed.operations.map((operation) => operation.kind)).toEqual(['put-file'])

    const refused = planSync({
      mode: 'push',
      local: source,
      remote: [file('remote.txt', 'remote')],
      baseline: null,
    })
    expect(refused.conflicts[0]?.kind).toBe('first-sync-target-not-empty')
    expect(refused.operations).toEqual([])
  })

  it('plans a one-sided modification in the selected direction', () => {
    const before = file('a.txt', 'one')
    const after = file('a.txt', 'two')
    const plan = planSync({
      mode: 'push',
      local: [after],
      remote: [before],
      baseline: verified([before]),
    })
    expect(plan.conflicts).toEqual([])
    expect(plan.modifications).toEqual([{ side: 'local', kind: 'modification', path: 'a.txt' }])
    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: 'put-file', source: 'local', path: 'a.txt' }),
    ])
  })

  it('refuses a directional overwrite when only the target changed', () => {
    const before = file('a.txt', 'one')
    const remote = file('a.txt', 'remote')
    const plan = planSync({
      mode: 'push',
      local: [before],
      remote: [remote],
      baseline: verified([before]),
    })
    expect(plan.conflicts).toEqual([
      { kind: 'target-changed', path: 'a.txt', relatedPaths: ['a.txt'] },
    ])
    expect(plan.operations).toEqual([])
  })

  it('reports divergent both-side and delete-modify conflicts', () => {
    const before = file('a.txt', 'one')
    const both = planSync({
      mode: 'diff',
      local: [file('a.txt', 'local')],
      remote: [file('a.txt', 'remote')],
      baseline: verified([before]),
    })
    expect(both.conflicts[0]?.kind).toBe('both-changed')

    const deleteModify = planSync({
      mode: 'pull',
      local: [],
      remote: [file('a.txt', 'remote')],
      baseline: verified([before]),
    })
    expect(deleteModify.conflicts[0]?.kind).toBe('delete-modify')
  })

  it('accepts converged both-side changes without an operation', () => {
    const before = file('a.txt', 'one')
    const same = file('a.txt', 'same')
    const plan = planSync({
      mode: 'push',
      local: [same],
      remote: [same],
      baseline: verified([before]),
    })
    expect(plan.conflicts).toEqual([])
    expect(plan.operations).toEqual([])
  })

  it('collapses an unambiguous file move into a rename operation', () => {
    const before = file('old.txt', 'same')
    const after = file('new.txt', 'same')
    const plan = planSync({
      mode: 'push',
      local: [after],
      remote: [before],
      baseline: verified([before]),
    })
    expect(plan.renames).toEqual([
      expect.objectContaining({ side: 'local', fromPath: 'old.txt', toPath: 'new.txt' }),
    ])
    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: 'rename', fromPath: 'old.txt', path: 'new.txt' }),
    ])
    expect(plan.requiresDeletionApproval).toBe(false)
  })

  it('refuses ambiguous rename candidates and explicit deletions require approval', () => {
    const first = file('one.txt', 'same')
    const second = file('two.txt', 'same')
    const before = [first, second]
    const ambiguous = planSync({
      mode: 'push',
      local: [file('three.txt', 'same')],
      remote: before,
      baseline: verified(before),
    })
    expect(ambiguous.conflicts.some((conflict) => conflict.kind === 'ambiguous-rename')).toBe(true)
    expect(ambiguous.operations).toEqual([])

    const deletion = planSync({
      mode: 'push',
      local: [],
      remote: [first],
      baseline: verified([first]),
    })
    expect(deletion.operations[0]?.kind).toBe('delete')
    expect(deletion.requiresDeletionApproval).toBe(true)
  })

  it('fails closed on an unverified baseline', () => {
    const plan = planSync({
      mode: 'pull',
      local: [],
      remote: [],
      baseline: { schemaVersion: 1, verified: false },
    })
    expect(plan.conflicts[0]?.kind).toBe('unverified-baseline')
    expect(plan.operations).toEqual([])
  })
})

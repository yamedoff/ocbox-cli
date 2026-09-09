import type { SyncBaselineEvidence, SyncSnapshotEntry } from './baseline.js'
import type { ManifestPath } from './path-policy.js'

export type SyncMode = 'diff' | 'pull' | 'push'
export type SyncSide = 'local' | 'remote'
export type SyncChangeKind = 'addition' | 'deletion' | 'modification'

export interface SyncChange {
  readonly side: SyncSide
  readonly kind: SyncChangeKind
  readonly path: ManifestPath
}

export interface SyncRename {
  readonly side: SyncSide
  readonly fromPath: ManifestPath
  readonly toPath: ManifestPath
  readonly sha256: string
}

export type SyncConflictKind =
  | 'ambiguous-rename'
  | 'both-changed'
  | 'delete-modify'
  | 'first-sync-target-not-empty'
  | 'target-changed'
  | 'unverified-baseline'

export interface SyncConflict {
  readonly kind: SyncConflictKind
  readonly path: ManifestPath | null
  readonly relatedPaths: readonly ManifestPath[]
}

export type SyncOperationKind = 'delete' | 'ensure-directory' | 'put-file' | 'rename'

export interface SyncOperation {
  readonly kind: SyncOperationKind
  readonly source: SyncSide
  readonly path: ManifestPath
  readonly fromPath: ManifestPath | null
  readonly entry: SyncSnapshotEntry | null
}

export interface SyncPlan {
  readonly schemaVersion: 1
  readonly mode: SyncMode
  readonly firstSync: boolean
  readonly additions: readonly SyncChange[]
  readonly modifications: readonly SyncChange[]
  readonly deletions: readonly SyncChange[]
  readonly renames: readonly SyncRename[]
  readonly conflicts: readonly SyncConflict[]
  readonly operations: readonly SyncOperation[]
  readonly requiresDeletionApproval: boolean
}

interface Delta {
  readonly kind: 'addition' | 'deletion' | 'modification' | 'unchanged'
  readonly before: SyncSnapshotEntry | undefined
  readonly after: SyncSnapshotEntry | undefined
}

interface RenameAnalysis {
  readonly renames: readonly SyncRename[]
  readonly ambiguous: readonly (readonly ManifestPath[])[]
}

function comparePath(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function entriesEqual(
  left: SyncSnapshotEntry | undefined,
  right: SyncSnapshotEntry | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return (
    left.path === right.path &&
    left.type === right.type &&
    left.size === right.size &&
    left.sha256 === right.sha256 &&
    left.mode === right.mode &&
    left.linkTarget === right.linkTarget
  )
}

function delta(before: SyncSnapshotEntry | undefined, after: SyncSnapshotEntry | undefined): Delta {
  if (entriesEqual(before, after)) return { kind: 'unchanged', before, after }
  if (before === undefined) return { kind: 'addition', before, after }
  if (after === undefined) return { kind: 'deletion', before, after }
  return { kind: 'modification', before, after }
}

function entryMap(entries: readonly SyncSnapshotEntry[]): Map<ManifestPath, SyncSnapshotEntry> {
  const result = new Map<ManifestPath, SyncSnapshotEntry>()
  for (const entry of entries) {
    if (result.has(entry.path))
      throw new TypeError('A sync snapshot cannot contain duplicate paths')
    result.set(entry.path, entry)
  }
  return result
}

function change(side: SyncSide, current: Delta, path: ManifestPath): SyncChange | null {
  if (current.kind === 'unchanged') return null
  return { side, kind: current.kind, path }
}

function renameSignature(entry: SyncSnapshotEntry | undefined): string | null {
  if (entry?.type !== 'file' || entry.sha256 === null) return null
  return `${entry.size}:${entry.sha256}`
}

function detectRenames(side: SyncSide, deltas: ReadonlyMap<ManifestPath, Delta>): RenameAnalysis {
  const deleted = new Map<string, ManifestPath[]>()
  const added = new Map<string, ManifestPath[]>()
  for (const [path, current] of deltas) {
    const beforeSignature = current.kind === 'deletion' ? renameSignature(current.before) : null
    if (beforeSignature !== null) {
      const paths = deleted.get(beforeSignature) ?? []
      paths.push(path)
      deleted.set(beforeSignature, paths)
    }
    const afterSignature = current.kind === 'addition' ? renameSignature(current.after) : null
    if (afterSignature !== null) {
      const paths = added.get(afterSignature) ?? []
      paths.push(path)
      added.set(afterSignature, paths)
    }
  }

  const renames: SyncRename[] = []
  const ambiguous: ManifestPath[][] = []
  for (const [signature, fromPaths] of deleted) {
    const toPaths = added.get(signature)
    if (toPaths === undefined) continue
    fromPaths.sort(comparePath)
    toPaths.sort(comparePath)
    if (fromPaths.length === 1 && toPaths.length === 1) {
      const fromPath = fromPaths[0]
      const toPath = toPaths[0]
      const separator = signature.indexOf(':')
      const sha256 = signature.slice(separator + 1)
      if (fromPath !== undefined && toPath !== undefined && separator > 0) {
        renames.push({ side, fromPath, toPath, sha256 })
      }
    } else {
      ambiguous.push([...fromPaths, ...toPaths].sort(comparePath))
    }
  }
  return {
    renames: renames.sort((left, right) => comparePath(left.fromPath, right.fromPath)),
    ambiguous: ambiguous.sort((left, right) => comparePath(left[0] ?? '', right[0] ?? '')),
  }
}

function operationForDelta(
  source: SyncSide,
  path: ManifestPath,
  sourceDelta: Delta,
): SyncOperation | null {
  if (sourceDelta.kind === 'unchanged') return null
  if (sourceDelta.kind === 'deletion') {
    return { kind: 'delete', source, path, fromPath: null, entry: null }
  }
  const entry = sourceDelta.after
  if (entry === undefined) throw new TypeError('Changed source entry is missing')
  return {
    kind: entry.type === 'directory' ? 'ensure-directory' : 'put-file',
    source,
    path,
    fromPath: null,
    entry,
  }
}

function sortChanges(changes: SyncChange[]): SyncChange[] {
  return changes.sort((left, right) => {
    const byPath = comparePath(left.path, right.path)
    return byPath === 0 ? left.side.localeCompare(right.side) : byPath
  })
}

function sortConflicts(conflicts: SyncConflict[]): SyncConflict[] {
  return conflicts.sort((left, right) => {
    const byPath = comparePath(left.path ?? '', right.path ?? '')
    return byPath === 0 ? left.kind.localeCompare(right.kind) : byPath
  })
}

function firstSyncPlan(
  mode: SyncMode,
  local: readonly SyncSnapshotEntry[],
  remote: readonly SyncSnapshotEntry[],
): SyncPlan {
  const additions: SyncChange[] = [
    ...local.map((entry) => ({ side: 'local', kind: 'addition', path: entry.path }) as const),
    ...remote.map((entry) => ({ side: 'remote', kind: 'addition', path: entry.path }) as const),
  ]
  const operations: SyncOperation[] = []
  const conflicts: SyncConflict[] = []
  const source = mode === 'push' ? local : remote
  const target = mode === 'push' ? remote : local
  const sourceSide: SyncSide = mode === 'push' ? 'local' : 'remote'

  if (mode !== 'diff') {
    if (target.length > 0) {
      conflicts.push({
        kind: 'first-sync-target-not-empty',
        path: null,
        relatedPaths: target.map((entry) => entry.path).sort(comparePath),
      })
    } else {
      for (const entry of source) {
        operations.push({
          kind: entry.type === 'directory' ? 'ensure-directory' : 'put-file',
          source: sourceSide,
          path: entry.path,
          fromPath: null,
          entry,
        })
      }
    }
  } else if (local.length > 0 && remote.length > 0) {
    conflicts.push({
      kind: 'first-sync-target-not-empty',
      path: null,
      relatedPaths: [...local, ...remote].map((entry) => entry.path).sort(comparePath),
    })
  }

  return {
    schemaVersion: 1,
    mode,
    firstSync: true,
    additions: sortChanges(additions),
    modifications: [],
    deletions: [],
    renames: [],
    conflicts,
    operations: conflicts.length === 0 ? operations : [],
    requiresDeletionApproval: false,
  }
}

/**
 * Builds a non-mutating three-way plan. A push or pull emits operations only
 * when the selected source changed and the target still matches the baseline.
 */
export function planSync(input: {
  readonly mode: SyncMode
  readonly local: readonly SyncSnapshotEntry[]
  readonly remote: readonly SyncSnapshotEntry[]
  readonly baseline: SyncBaselineEvidence | null
}): SyncPlan {
  const { mode } = input
  const localMap = entryMap(input.local)
  const remoteMap = entryMap(input.remote)
  if (input.baseline === null) return firstSyncPlan(mode, input.local, input.remote)
  if (!input.baseline.verified) {
    return {
      schemaVersion: 1,
      mode,
      firstSync: false,
      additions: [],
      modifications: [],
      deletions: [],
      renames: [],
      conflicts: [{ kind: 'unverified-baseline', path: null, relatedPaths: [] }],
      operations: [],
      requiresDeletionApproval: false,
    }
  }

  const baselineMap = entryMap(input.baseline.entries)
  const paths = [...new Set([...baselineMap.keys(), ...localMap.keys(), ...remoteMap.keys()])].sort(
    comparePath,
  )
  const localDeltas = new Map<ManifestPath, Delta>()
  const remoteDeltas = new Map<ManifestPath, Delta>()
  const additions: SyncChange[] = []
  const modifications: SyncChange[] = []
  const deletions: SyncChange[] = []
  const conflicts: SyncConflict[] = []
  const operations: SyncOperation[] = []
  const sourceSide: SyncSide | null = mode === 'push' ? 'local' : mode === 'pull' ? 'remote' : null

  for (const path of paths) {
    const localDelta = delta(baselineMap.get(path), localMap.get(path))
    const remoteDelta = delta(baselineMap.get(path), remoteMap.get(path))
    localDeltas.set(path, localDelta)
    remoteDeltas.set(path, remoteDelta)
    for (const item of [change('local', localDelta, path), change('remote', remoteDelta, path)]) {
      if (item?.kind === 'addition') additions.push(item)
      if (item?.kind === 'modification') modifications.push(item)
      if (item?.kind === 'deletion') deletions.push(item)
    }

    if (entriesEqual(localDelta.after, remoteDelta.after)) continue
    const localChanged = localDelta.kind !== 'unchanged'
    const remoteChanged = remoteDelta.kind !== 'unchanged'
    if (localChanged && remoteChanged) {
      conflicts.push({
        kind:
          localDelta.kind === 'deletion' || remoteDelta.kind === 'deletion'
            ? 'delete-modify'
            : 'both-changed',
        path,
        relatedPaths: [path],
      })
      continue
    }
    if (sourceSide === null) continue
    const sourceDelta = sourceSide === 'local' ? localDelta : remoteDelta
    const targetDelta = sourceSide === 'local' ? remoteDelta : localDelta
    if (targetDelta.kind !== 'unchanged') {
      conflicts.push({ kind: 'target-changed', path, relatedPaths: [path] })
      continue
    }
    const operation = operationForDelta(sourceSide, path, sourceDelta)
    if (operation !== null) operations.push(operation)
  }

  const localRenames = detectRenames('local', localDeltas)
  const remoteRenames = detectRenames('remote', remoteDeltas)
  for (const group of [...localRenames.ambiguous, ...remoteRenames.ambiguous]) {
    conflicts.push({ kind: 'ambiguous-rename', path: group[0] ?? null, relatedPaths: group })
  }
  const renames = [...localRenames.renames, ...remoteRenames.renames].sort((left, right) =>
    comparePath(left.fromPath, right.fromPath),
  )
  const renamedChangeKeys = new Set(
    renames.flatMap((rename) => [
      `${rename.side}:addition:${rename.toPath}`,
      `${rename.side}:deletion:${rename.fromPath}`,
    ]),
  )
  const withoutRenameParts = (items: readonly SyncChange[]) =>
    items.filter((item) => !renamedChangeKeys.has(`${item.side}:${item.kind}:${item.path}`))

  if (sourceSide !== null) {
    const relevantRenames = renames.filter((rename) => rename.side === sourceSide)
    for (const rename of relevantRenames) {
      const deleteIndex = operations.findIndex(
        (operation) => operation.kind === 'delete' && operation.path === rename.fromPath,
      )
      const putIndex = operations.findIndex(
        (operation) => operation.kind === 'put-file' && operation.path === rename.toPath,
      )
      if (deleteIndex >= 0 && putIndex >= 0) {
        const entry = operations[putIndex]?.entry ?? null
        operations.splice(Math.max(deleteIndex, putIndex), 1)
        operations.splice(Math.min(deleteIndex, putIndex), 1)
        operations.push({
          kind: 'rename',
          source: sourceSide,
          path: rename.toPath,
          fromPath: rename.fromPath,
          entry,
        })
      }
    }
  }

  const finalConflicts = sortConflicts(conflicts)
  const finalOperations =
    finalConflicts.length === 0
      ? operations.sort((left, right) => comparePath(left.path, right.path))
      : []
  return {
    schemaVersion: 1,
    mode,
    firstSync: false,
    additions: sortChanges(withoutRenameParts(additions)),
    modifications: sortChanges(modifications),
    deletions: sortChanges(withoutRenameParts(deletions)),
    renames,
    conflicts: finalConflicts,
    operations: finalOperations,
    requiresDeletionApproval: finalOperations.some((operation) => operation.kind === 'delete'),
  }
}

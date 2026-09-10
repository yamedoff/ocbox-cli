import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { decodeSyncArchive } from './archive.js'
import type { SyncSnapshotEntry } from './baseline.js'
import { normalizeManifestPath } from './path-policy.js'
import {
  type TransferAdapter,
  type TransferApplyIntent,
  TransferError,
  type TransferRecoveryStatus,
  type TransferTransaction,
} from './transfer.js'

interface Journal {
  readonly schemaVersion: 1
  readonly operationId: string
  readonly stage: 'staged' | 'target-moving' | 'target-moved' | 'committed'
  /** Whether a target existed when the destructive move was about to begin. */
  readonly hadTarget: boolean | null
  readonly stagingDirectory: string
  readonly backupDirectory: string
}

type JournalReadResult =
  | { readonly state: 'none' }
  | { readonly state: 'valid'; readonly journal: Journal }
  | { readonly state: 'corrupt' }

/**
 * A safe local/fake transfer endpoint. Its journal stores only names relative
 * to its private state directory; it never persists the caller's root path.
 * `interruptAfterTargetMove` exists solely to exercise crash recovery.
 */
export class LocalTransferAdapter implements TransferAdapter {
  readonly name = 'local-fake'
  private readonly targetRoot: string
  private readonly stateDirectory: string
  private readonly journalPath: string

  constructor(
    targetRoot: string,
    private readonly options: {
      readonly interruptAfterTargetMove?: boolean
      /** Test hook for the journal window immediately after the destructive move. */
      readonly interruptBeforeTargetMoveJournal?: boolean
    } = {},
  ) {
    // Freeze the absolute root so later filesystem calls never depend on cwd.
    this.targetRoot = resolve(targetRoot)
    const parent = dirname(this.targetRoot)
    this.stateDirectory = join(parent, `.${basename(this.targetRoot)}.ocbox-sync-state`)
    this.journalPath = join(this.stateDirectory, 'journal.json')
  }

  async beginApply(intent: TransferApplyIntent): Promise<TransferTransaction> {
    if ((await this.recoveryStatus()).recoveryRequired) throw new TransferError('RECOVERY_REQUIRED')
    // A linked target root is never dereferenced or replaced.
    if (await isSymbolicLink(this.targetRoot)) throw new TransferError('UNSAFE_TARGET')
    if (!intent.allowReplace) {
      const targetStat = await lstat(this.targetRoot).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (targetStat !== null) {
        // A non-directory target is treated as occupied, and so is any directory
        // content; both demand explicit approval instead of a raw ENOTDIR.
        if (!targetStat.isDirectory()) throw new TransferError('REPLACE_NOT_APPROVED')
        const names = await readdir(this.targetRoot)
        if (names.length > 0) throw new TransferError('REPLACE_NOT_APPROVED')
      }
    }
    await mkdir(this.stateDirectory, { recursive: true })
    const id = randomUUID()
    const stagingDirectory = `stage-${id}`
    const backupDirectory = `backup-${id}`
    const journal: Journal = {
      schemaVersion: 1,
      operationId: id,
      stage: 'staged',
      hadTarget: null,
      stagingDirectory,
      backupDirectory,
    }
    await mkdir(join(this.stateDirectory, stagingDirectory))
    try {
      await writeFile(this.journalPath, JSON.stringify(journal), {
        encoding: 'utf8',
        flag: 'wx',
        flush: true,
      })
    } catch (error) {
      await rm(join(this.stateDirectory, stagingDirectory), { force: true, recursive: true })
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new TransferError('RECOVERY_REQUIRED')
      throw error
    }
    return new LocalTransferTransaction(this, journal)
  }

  async recoveryStatus(): Promise<TransferRecoveryStatus> {
    const result = await this.readJournal()
    return {
      // A corrupt journal still requires recovery; the operation id is unknown.
      recoveryRequired: result.state !== 'none',
      operationId: result.state === 'valid' ? result.journal.operationId : null,
    }
  }

  /**
   * Recovery invariants: never promote staged content and never delete an
   * ambiguous backup. A `target-moving` journal means intent was durable but the
   * destructive move may or may not have happened, so the original target is
   * restored (or its original absence preserved). A `target-moved` journal with
   * both target and backup present is ambiguous and refuses automatic recovery.
   */
  async recover(): Promise<void> {
    const result = await this.readJournal()
    if (result.state === 'none') return
    if (result.state === 'corrupt') throw new TransferError('RECOVERY_REQUIRED')
    const { journal } = result
    const backup = join(this.stateDirectory, journal.backupDirectory)
    if (journal.stage === 'target-moving') {
      const targetExists = await exists(this.targetRoot)
      const backupExists = await exists(backup)
      if (journal.hadTarget === true && !targetExists && backupExists) {
        // Restore the preserved original target after an interrupted move.
        await rename(backup, this.targetRoot)
      } else if (
        (journal.hadTarget === true && targetExists && !backupExists) ||
        (journal.hadTarget === false && !targetExists && !backupExists)
      ) {
        // The intent was durable, but no destructive move was observed.
        // Keeping the original target (or its original absence) is safe.
      } else {
        throw new TransferError('RECOVERY_REQUIRED')
      }
    }
    if (journal.stage === 'target-moved' && (await exists(backup))) {
      // A concurrent replacement is never safe to delete during recovery.
      if (await exists(this.targetRoot)) throw new TransferError('RECOVERY_REQUIRED')
      await rename(backup, this.targetRoot)
    }
    if (journal.stage === 'committed') {
      // The verified target was installed. Only discard the preserved copy while
      // the installed target still exists; otherwise restore the backup.
      if (await exists(backup)) {
        if (await exists(this.targetRoot)) {
          await rm(backup, { force: true, recursive: true })
        } else {
          await rename(backup, this.targetRoot)
        }
      }
    }
    await rm(join(this.stateDirectory, journal.stagingDirectory), { force: true, recursive: true })
    await this.sweepAbandonedTemporaryJournals()
    await rm(this.journalPath, { force: true })
  }

  /**
   * `writeJournal` replaces the journal through a temporary file. A crash
   * between the write and the rename leaves abandoned `*.tmp` peers; this sweep
   * removes them once the caller owns recovery and no journal rename is in
   * flight. Recovery must run exclusively (documented operational contract).
   */
  private async sweepAbandonedTemporaryJournals(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.stateDirectory)
    } catch {
      return
    }
    await Promise.all(
      names
        .filter((name) => name.startsWith('journal.json.') && name.endsWith('.tmp'))
        .map((name) => rm(join(this.stateDirectory, name), { force: true })),
    )
  }

  private async readJournal(): Promise<JournalReadResult> {
    let contents: string
    try {
      contents = await readFile(this.journalPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'none' }
      throw error
    }
    try {
      const value: unknown = JSON.parse(contents)
      if (isJournal(value)) return { state: 'valid', journal: value }
    } catch {
      // Fall through to the corrupt result below.
    }
    // A partially written journal must fail closed: recovery state is unknown.
    return { state: 'corrupt' }
  }

  async updateJournal(journal: Journal): Promise<void> {
    await writeJournal(this.journalPath, journal)
  }
  statePath(name: string): string {
    return join(this.stateDirectory, name)
  }
  target(): string {
    return this.targetRoot
  }
  shouldInterrupt(): boolean {
    return this.options.interruptAfterTargetMove === true
  }
  shouldInterruptBeforeTargetMoveJournal(): boolean {
    return this.options.interruptBeforeTargetMoveJournal === true
  }
}

class LocalTransferTransaction implements TransferTransaction {
  private staged = false
  private done = false
  constructor(
    private readonly adapter: LocalTransferAdapter,
    private journal: Journal,
  ) {}

  async stage(
    entries: readonly SyncSnapshotEntry[],
    archive: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    if (this.done || this.staged) throw new TransferError('RECOVERY_REQUIRED')
    const expected = new Map(entries.map((entry) => [entry.path, entry]))
    const declared = new Set<string>()
    const seen = new Map<
      string,
      {
        handle: Awaited<ReturnType<typeof open>>
        hash: ReturnType<typeof createHash>
        size: number
      }
    >()
    try {
      for await (const event of decodeSyncArchive(archive)) {
        if (event.type === 'entry') {
          const entry = expected.get(event.entry.path)
          if (entry === undefined || !entriesMatch(entry, event.entry))
            throw new TransferError('INTEGRITY')
          declared.add(event.entry.path)
          const path = safeJoin(
            this.adapter.statePath(this.journal.stagingDirectory),
            event.entry.path,
          )
          if (event.entry.type === 'directory')
            await mkdir(path, { recursive: true, mode: event.entry.mode })
          else {
            await mkdir(dirname(path), { recursive: true })
            seen.set(event.entry.path, {
              handle: await open(path, 'wx', event.entry.mode),
              hash: createHash('sha256'),
              size: 0,
            })
          }
        } else if (event.type === 'data') {
          const current = seen.get(event.path)
          if (current === undefined) throw new TransferError('INTEGRITY')
          current.size += event.data.byteLength
          current.hash.update(event.data)
          // FileHandle.write may write fewer bytes than requested; loop so the
          // staged bytes always match the verified checksum.
          await writeAll(current.handle, event.data)
        }
      }
      for (const entry of entries) {
        if (entry.type !== 'file') continue
        const current = seen.get(entry.path)
        if (
          current === undefined ||
          current.size !== entry.size ||
          current.hash.digest('hex') !== entry.sha256
        )
          throw new TransferError('INTEGRITY')
        await current.handle.close()
      }
      if (declared.size !== expected.size) throw new TransferError('INTEGRITY')
      this.staged = true
    } catch (error) {
      await Promise.allSettled([...seen.values()].map((current) => current.handle.close()))
      throw error
    }
  }

  async commit(): Promise<void> {
    if (!this.staged || this.done) throw new TransferError('RECOVERY_REQUIRED')
    const target = this.adapter.target()
    const backup = this.adapter.statePath(this.journal.backupDirectory)
    // Persist intent before moving the target. Otherwise a crash after rename
    // but before the journal update leaves only an orphaned backup to recover.
    const targetExists = await exists(target)
    this.journal = { ...this.journal, stage: 'target-moving', hadTarget: targetExists }
    await this.adapter.updateJournal(this.journal)
    if (targetExists) await rename(target, backup)
    if (this.adapter.shouldInterruptBeforeTargetMoveJournal()) {
      throw new Error('simulated interruption before target-moved journal')
    }
    this.journal = { ...this.journal, stage: 'target-moved' }
    await this.adapter.updateJournal(this.journal)
    if (this.adapter.shouldInterrupt()) throw new Error('simulated interruption')
    await rename(this.adapter.statePath(this.journal.stagingDirectory), target)
    this.journal = { ...this.journal, stage: 'committed' }
    await this.adapter.updateJournal(this.journal)
    await rm(backup, { force: true, recursive: true })
    await rm(this.adapter.statePath('journal.json'), { force: true })
    this.done = true
  }

  async rollback(): Promise<void> {
    if (this.done) return
    if (this.journal.stage === 'target-moving' || this.journal.stage === 'target-moved') {
      await this.adapter.recover()
      this.done = true
      return
    }
    await rm(this.adapter.statePath(this.journal.stagingDirectory), {
      force: true,
      recursive: true,
    })
    await rm(this.adapter.statePath('journal.json'), { force: true })
    this.done = true
  }
}

function entriesMatch(left: SyncSnapshotEntry, right: SyncSnapshotEntry): boolean {
  return (
    left.path === right.path &&
    left.type === right.type &&
    left.size === right.size &&
    left.sha256 === right.sha256 &&
    left.mode === right.mode &&
    left.linkTarget === right.linkTarget
  )
}
function safeJoin(root: string, path: string): string {
  const normalized = normalizeManifestPath(path)
  const candidate = resolve(root, ...normalized.split('/'))
  const rel = relative(root, candidate)
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new TransferError('INTEGRITY')
  return candidate
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}
async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch {
    return false
  }
}
async function writeAll(handle: Awaited<ReturnType<typeof open>>, data: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < data.byteLength) {
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset)
    if (bytesWritten <= 0) throw new TransferError('INTEGRITY')
    offset += bytesWritten
  }
}

/**
 * Replaces the journal atomically so a crash can never observe a half-written
 * journal. The rename is atomic on a single filesystem, which the state
 * directory always shares with the target.
 */
async function writeJournal(path: string, journal: Journal): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(journal), { encoding: 'utf8', flush: true })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
function isJournal(value: unknown): value is Journal {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<Journal>
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.operationId === 'string' &&
    (candidate.stage === 'staged' ||
      candidate.stage === 'target-moving' ||
      candidate.stage === 'target-moved' ||
      candidate.stage === 'committed') &&
    (candidate.stage === 'staged'
      ? candidate.hadTarget === null
      : typeof candidate.hadTarget === 'boolean') &&
    /^stage-[0-9a-f-]+$/.test(candidate.stagingDirectory ?? '') &&
    /^backup-[0-9a-f-]+$/.test(candidate.backupDirectory ?? '')
  )
}

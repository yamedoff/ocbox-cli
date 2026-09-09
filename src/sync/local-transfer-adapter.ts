import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
  readonly stage: 'staged' | 'target-moved' | 'committed'
  readonly stagingDirectory: string
  readonly backupDirectory: string
}

/**
 * A safe local/fake transfer endpoint. Its journal stores only names relative
 * to its private state directory; it never persists the caller's root path.
 * `interruptAfterTargetMove` exists solely to exercise crash recovery.
 */
export class LocalTransferAdapter implements TransferAdapter {
  readonly name = 'local-fake'
  private readonly stateDirectory: string
  private readonly journalPath: string

  constructor(
    private readonly targetRoot: string,
    private readonly options: { readonly interruptAfterTargetMove?: boolean } = {},
  ) {
    const parent = dirname(resolve(targetRoot))
    this.stateDirectory = join(parent, `.${basename(targetRoot)}.ocbox-sync-state`)
    this.journalPath = join(this.stateDirectory, 'journal.json')
  }

  async beginApply(intent: TransferApplyIntent): Promise<TransferTransaction> {
    if ((await this.recoveryStatus()).recoveryRequired) throw new TransferError('RECOVERY_REQUIRED')
    if (!intent.allowReplace && (await exists(this.targetRoot))) {
      const names = await (await import('node:fs/promises')).readdir(this.targetRoot)
      if (names.length > 0) throw new TransferError('REPLACE_NOT_APPROVED')
    }
    await mkdir(this.stateDirectory, { recursive: true })
    const id = randomUUID()
    const stagingDirectory = `stage-${id}`
    const backupDirectory = `backup-${id}`
    const journal: Journal = {
      schemaVersion: 1,
      operationId: id,
      stage: 'staged',
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
    const journal = await this.readJournal()
    return {
      recoveryRequired: journal !== null,
      operationId: journal?.operationId ?? null,
    }
  }

  /** Explicitly restores the last preserved target; it never promotes partial staging. */
  async recover(): Promise<void> {
    const journal = await this.readJournal()
    if (journal === null) return
    const backup = join(this.stateDirectory, journal.backupDirectory)
    if (journal.stage === 'target-moved' && (await exists(backup))) {
      // A concurrent replacement is never safe to delete during recovery.
      if (await exists(this.targetRoot)) throw new TransferError('RECOVERY_REQUIRED')
      await rename(backup, this.targetRoot)
    }
    if (journal.stage === 'committed') {
      // The new target was installed; only the preserved copy remains to clean up.
      await rm(backup, { force: true, recursive: true })
    }
    await rm(join(this.stateDirectory, journal.stagingDirectory), { force: true, recursive: true })
    await rm(this.journalPath, { force: true })
  }

  private async readJournal(): Promise<Journal | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.journalPath, 'utf8'))
      if (!isJournal(value)) throw new TransferError('RECOVERY_REQUIRED')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
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
          if (entry === undefined || JSON.stringify(entry) !== JSON.stringify(event.entry))
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
          await current.handle.write(event.data)
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
    if (await exists(target)) await rename(target, backup)
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
    if (this.journal.stage === 'target-moved') {
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
async function writeJournal(path: string, journal: Journal): Promise<void> {
  await writeFile(path, JSON.stringify(journal), { encoding: 'utf8', flush: true })
}
function isJournal(value: unknown): value is Journal {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<Journal>
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.operationId === 'string' &&
    (candidate.stage === 'staged' ||
      candidate.stage === 'target-moved' ||
      candidate.stage === 'committed') &&
    /^stage-[0-9a-f-]+$/.test(candidate.stagingDirectory ?? '') &&
    /^backup-[0-9a-f-]+$/.test(candidate.backupDirectory ?? '')
  )
}

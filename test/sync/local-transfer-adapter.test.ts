import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeSyncArchive } from '../../src/sync/archive.js'
import { type SyncSnapshotEntry, SyncSnapshotEntrySchema } from '../../src/sync/baseline.js'
import { LocalTransferAdapter } from '../../src/sync/local-transfer-adapter.js'
import { normalizeManifestPath } from '../../src/sync/path-policy.js'
import { TransferError } from '../../src/sync/transfer.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

function entry(path: string, content: Uint8Array): SyncSnapshotEntry {
  return SyncSnapshotEntrySchema.parse({
    path: normalizeManifestPath(path),
    type: 'file',
    size: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
    mode: 0o640,
    linkTarget: null,
  })
}
async function archive(
  entries: readonly SyncSnapshotEntry[],
  contents: ReadonlyMap<string, Uint8Array>,
): Promise<AsyncIterable<Uint8Array>> {
  return encodeSyncArchive(entries, async function* (path) {
    yield contents.get(path) ?? new Uint8Array()
  })
}

describe('local transfer adapter', () => {
  it('stages, verifies and replaces only with explicit approval', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ocbox-transfer-'))
    roots.push(parent)
    const target = join(parent, 'target')
    await mkdir(target)
    await writeFile(join(target, 'old'), 'old')
    const content = new TextEncoder().encode('new binary \u0000 content')
    const next = entry('nested/value.bin', content)
    const adapter = new LocalTransferAdapter(target)
    await expect(adapter.beginApply({ allowReplace: false })).rejects.toMatchObject({
      code: 'REPLACE_NOT_APPROVED',
    })
    const transaction = await adapter.beginApply({ allowReplace: true })
    await transaction.stage([next], await archive([next], new Map([[next.path, content]])))
    await transaction.commit()
    await expect(readFile(join(target, 'nested', 'value.bin'))).resolves.toEqual(
      Buffer.from(content),
    )
    expect(await adapter.recoveryStatus()).toEqual({ recoveryRequired: false, operationId: null })
  })

  it('does not replace the target when archive checksum verification fails', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ocbox-transfer-'))
    roots.push(parent)
    const target = join(parent, 'target')
    await mkdir(target)
    await writeFile(join(target, 'preserve'), 'preserve')
    const expected = entry('value.txt', new TextEncoder().encode('expected'))
    const adapter = new LocalTransferAdapter(target)
    const transaction = await adapter.beginApply({ allowReplace: true })
    await expect(
      transaction.stage(
        [expected],
        await archive([expected], new Map([[expected.path, new TextEncoder().encode('wrong')]])),
      ),
    ).rejects.toBeDefined()
    await expect(readFile(join(target, 'preserve'), 'utf8')).resolves.toBe('preserve')
    await transaction.rollback()
  })

  it('persists a relative journal and requires explicit recovery after interruption', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ocbox-transfer-'))
    roots.push(parent)
    const target = join(parent, 'target')
    await mkdir(target)
    await writeFile(join(target, 'preserve'), 'preserve')
    const content = new TextEncoder().encode('new')
    const next = entry('value.txt', content)
    const adapter = new LocalTransferAdapter(target, { interruptAfterTargetMove: true })
    const transaction = await adapter.beginApply({ allowReplace: true })
    await transaction.stage([next], await archive([next], new Map([[next.path, content]])))
    await expect(transaction.commit()).rejects.toThrow('simulated interruption')
    const status = await adapter.recoveryStatus()
    expect(status.recoveryRequired).toBe(true)
    const stateDirectory = (await readdir(parent)).find((name) =>
      name.endsWith('.ocbox-sync-state'),
    )
    expect(stateDirectory).toBeDefined()
    const journal = await readFile(join(parent, stateDirectory ?? '', 'journal.json'), 'utf8')
    expect(journal).not.toContain(parent)
    expect(journal).toContain('"stagingDirectory"')
    expect(journal).toContain('"backupDirectory"')
    await expect(adapter.beginApply({ allowReplace: true })).rejects.toBeInstanceOf(TransferError)
    await adapter.recover()
    await expect(readFile(join(target, 'preserve'), 'utf8')).resolves.toBe('preserve')
    expect(await adapter.recoveryStatus()).toEqual({ recoveryRequired: false, operationId: null })
  })
})

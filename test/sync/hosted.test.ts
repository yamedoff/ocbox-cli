import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectIdSchema, SessionIdSchema } from '../../src/domain/ids.js'
import type { PreparedSource } from '../../src/providers/ocbox/source.js'
import { decodeSyncArchive } from '../../src/sync/archive.js'
import { cliRules } from '../../src/sync/ignore-rules.js'
import { createTransferAdapter } from '../../src/sync/provider-adapter.js'
import { runSyncApply, runSyncDiff, type SyncContext } from '../../src/sync/service.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ocbox-hosted-sync-'))
  roots.push(root)
  const localRoot = join(root, 'local')
  await mkdir(localRoot)
  const hostedUpload = vi.fn(async (_prepared: PreparedSource) => ({
    manifestId: 'manifest',
    verified: true,
    uploaded: true,
  }))
  const context: SyncContext = {
    providerName: 'ocbox',
    projectId: ProjectIdSchema.parse('11111111-1111-4111-8111-111111111111'),
    sessionId: SessionIdSchema.parse('22222222-2222-4222-8222-222222222222'),
    stateDirectory: join(root, 'state'),
    localRoot,
    remoteRoot: join(root, 'remote'),
    hostedUpload,
  }
  return { context, hostedUpload }
}
const options = {
  cliRules: [],
  delete: false,
  yes: false,
  interactive: false,
  confirm: async () => false,
}

describe('hosted sync', () => {
  it('uploads a deterministic OCBOXA1 archive and reports files and payload bytes', async () => {
    const { context, hostedUpload } = await setup()
    await writeFile(join(context.localRoot, 'a.txt'), 'hello')
    await writeFile(join(context.localRoot, '.env'), 'never upload')
    await mkdir(join(context.localRoot, 'nested'))
    await writeFile(join(context.localRoot, 'nested/b.txt'), 'world')
    const first = await runSyncApply(context, 'push', options)
    const second = await runSyncApply(context, 'push', options)
    expect(first.uploadedFiles).toEqual(['a.txt', 'nested/b.txt'])
    expect(first.uploadedBytes).toBe(10)
    expect(first.baselineUpdated).toBe(false)
    expect(second.archiveBytes).toBe(first.archiveBytes)
    const prepared = hostedUpload.mock.calls[0]?.[0] as PreparedSource
    const repeated = hostedUpload.mock.calls[1]?.[0] as PreparedSource
    expect(prepared.checksum).toBe(repeated.checksum)
    const events = []
    for await (const event of decodeSyncArchive(
      (async function* () {
        for (const chunk of prepared.chunks) yield chunk.bytes
      })(),
    ))
      events.push(event)
    expect(
      events.filter((event) => event.type === 'entry').map((event) => event.entry.path),
    ).toEqual(['a.txt', 'nested', 'nested/b.txt'])
    expect(first.excluded.some((item) => item.path === '.env')).toBe(true)
    await expect(readFile(join(context.remoteRoot, 'a.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('names oversized files and tells the user how to exclude them before dispatch', async () => {
    const { context, hostedUpload } = await setup()
    await writeFile(join(context.localRoot, 'large.bin'), Buffer.alloc(65537))
    await expect(runSyncApply(context, 'push', options)).rejects.toMatchObject({
      code: 'SYNC_TOO_LARGE',
      message: expect.stringMatching(/large\.bin.*65537.*--exclude.*\.opencloudboxignore/),
    })
    expect(hostedUpload).not.toHaveBeenCalled()
    const applied = await runSyncApply(context, 'push', {
      ...options,
      cliRules: cliRules(['large.bin'], []),
    })
    expect(applied.uploadedFiles).toEqual([])
  })

  it('keeps oversized-file diagnostics bounded with many long names', async () => {
    const { context, hostedUpload } = await setup()
    for (let i = 0; i < 10; i += 1)
      await writeFile(join(context.localRoot, `${i}${'large'.repeat(35)}.bin`), Buffer.alloc(65537))
    await expect(runSyncApply(context, 'push', options)).rejects.toMatchObject({
      code: 'SYNC_TOO_LARGE',
      message: expect.stringContaining('--exclude'),
    })
    expect(hostedUpload).not.toHaveBeenCalled()
  })

  it('accepts exact staging boundaries and rejects excessive total bytes', async () => {
    const { context, hostedUpload } = await setup()
    for (let i = 0; i < 8; i += 1)
      await writeFile(join(context.localRoot, `${i}.bin`), Buffer.alloc(65536))
    expect((await runSyncApply(context, 'push', options)).uploadedBytes).toBe(524288)
    hostedUpload.mockClear()
    await writeFile(join(context.localRoot, 'extra'), 'x')
    await expect(runSyncApply(context, 'push', options)).rejects.toMatchObject({
      code: 'SYNC_TOO_LARGE',
      message: expect.stringContaining('524289'),
    })
    expect(hostedUpload).not.toHaveBeenCalled()
  })

  it('rejects over 100 files before dispatch', async () => {
    const { context, hostedUpload } = await setup()
    for (let i = 0; i < 101; i += 1) await writeFile(join(context.localRoot, `${i}.txt`), '')
    await expect(runSyncApply(context, 'push', options)).rejects.toMatchObject({
      code: 'SYNC_TOO_LARGE',
      message: expect.stringContaining('101 files'),
    })
    expect(hostedUpload).not.toHaveBeenCalled()
  })

  it.runIf(process.platform !== 'win32')(
    'bounds archive metadata even for a directory-only tree',
    async () => {
      const { context, hostedUpload } = await setup()
      const parent = join(
        context.localRoot,
        ...Array.from({ length: 8 }, (_, i) => `${i}${'p'.repeat(199)}`),
      )
      await mkdir(parent, { recursive: true })
      for (let i = 0; i < 650; i += 1) await mkdir(join(parent, `${i}${'d'.repeat(96)}`))
      await expect(runSyncApply(context, 'push', options)).rejects.toMatchObject({
        code: 'SYNC_TOO_LARGE',
        message: expect.stringContaining('archive exceeds 1048576 bytes'),
      })
      expect(hostedUpload).not.toHaveBeenCalled()
    },
  )

  it('reports no transferred files for server-verified replay', async () => {
    const { context, hostedUpload } = await setup()
    hostedUpload.mockResolvedValue({ manifestId: 'manifest', verified: true, uploaded: false })
    await writeFile(join(context.localRoot, 'a.txt'), 'hello')
    const result = await runSyncApply(context, 'push', options)
    expect(result.applied).toBe(false)
    expect(result.uploadedBytes).toBe(0)
    expect(result.uploadedFiles).toEqual([])
    expect(result.operations).toEqual([])
  })

  it('rejects hosted readback, deletion and local transfer adapters', async () => {
    const { context, hostedUpload } = await setup()
    await expect(runSyncApply(context, 'pull', options)).rejects.toThrow(
      'not supported for hosted sandboxes yet',
    )
    await expect(runSyncDiff(context, options)).rejects.toThrow(
      'not supported for hosted sandboxes yet',
    )
    await expect(runSyncApply(context, 'push', { ...options, delete: true })).rejects.toThrow(
      'cannot delete remote files',
    )
    expect(() => createTransferAdapter('ocbox', context.remoteRoot)).toThrow(
      'does not implement a sync transfer adapter',
    )
    expect(hostedUpload).not.toHaveBeenCalled()
  })
})

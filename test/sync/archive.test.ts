import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  type DecodedSyncArchiveEvent,
  decodeSyncArchive,
  encodeSyncArchive,
} from '../../src/sync/archive.js'
import { type SyncSnapshotEntry, SyncSnapshotEntrySchema } from '../../src/sync/baseline.js'
import { type ManifestPath, normalizeManifestPath } from '../../src/sync/path-policy.js'

function entry(path: string, data: Uint8Array): SyncSnapshotEntry {
  return SyncSnapshotEntrySchema.parse({
    path: normalizeManifestPath(path),
    type: 'file',
    size: data.byteLength,
    sha256: createHash('sha256').update(data).digest('hex'),
    mode: 0o640,
    linkTarget: null,
  })
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const values: Uint8Array[] = []
  let size = 0
  for await (const chunk of chunks) {
    values.push(chunk)
    size += chunk.byteLength
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.byteLength
  }
  return result
}

async function* fragments(value: Uint8Array, width: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < value.byteLength; offset += width) {
    yield value.subarray(offset, Math.min(value.byteLength, offset + width))
  }
}

describe('streaming sync archive', () => {
  it('round-trips binary files over every small chunk width', async () => {
    const alpha = Uint8Array.of(0, 255, 1, 128, 10)
    const beta = new TextEncoder().encode('Unicode 🙂 content')
    const alphaEntry = entry('a.bin', alpha)
    const betaEntry = entry('nested/é.txt', beta)
    const entries = [alphaEntry, betaEntry]
    const content = new Map<ManifestPath, Uint8Array>([
      [alphaEntry.path, alpha],
      [betaEntry.path, beta],
    ])
    const archive = await collect(
      encodeSyncArchive(entries, async function* (path) {
        const data = content.get(path)
        if (data === undefined) throw new Error('missing fixture')
        yield data.subarray(0, 2)
        yield data.subarray(2)
      }),
    )

    for (const width of [1, 2, 3, 7, 31]) {
      const events: DecodedSyncArchiveEvent[] = []
      for await (const event of decodeSyncArchive(fragments(archive, width))) events.push(event)
      const decoded = new Map<string, number[]>()
      for (const event of events) {
        if (event.type !== 'data') continue
        decoded.set(event.path, [...(decoded.get(event.path) ?? []), ...event.data])
      }
      expect(decoded).toEqual(
        new Map([
          ['a.bin', [...alpha]],
          ['nested/é.txt', [...beta]],
        ]),
      )
      expect(events.at(-1)?.type).toBe('end')
    }
  })

  it('emits data before reading the next source chunk', async () => {
    const data = Uint8Array.of(1, 2, 3, 4)
    let secondChunkRead = false
    const encoded = encodeSyncArchive([entry('data.bin', data)], async function* () {
      yield data.subarray(0, 2)
      secondChunkRead = true
      yield data.subarray(2)
    })
    const iterator = encoded[Symbol.asyncIterator]()
    await iterator.next() // magic
    await iterator.next() // entry header
    const firstData = await iterator.next()
    expect(firstData.value).toEqual(data.subarray(0, 2))
    expect(secondChunkRead).toBe(false)
    await iterator.return?.()
  })

  it('rejects checksum mismatch, truncation and configured limits', async () => {
    const expected = entry('data.bin', Uint8Array.of(1, 2, 3))
    await expect(
      collect(
        encodeSyncArchive([expected], async function* () {
          yield Uint8Array.of(1, 2, 4)
        }),
      ),
    ).rejects.toMatchObject({ code: 'ARCHIVE_INTEGRITY' })

    const valid = await collect(
      encodeSyncArchive([expected], async function* () {
        yield Uint8Array.of(1, 2, 3)
      }),
    )
    await expect(async () => {
      for await (const _event of decodeSyncArchive(fragments(valid.subarray(0, -1), 2))) {
        // Drain the decoder so terminal validation runs.
      }
    }).rejects.toMatchObject({ code: 'ARCHIVE_FORMAT' })
    await expect(async () => {
      for await (const _event of decodeSyncArchive(fragments(valid, 2), { maxBytes: 2 })) {
        // Drain the decoder so byte caps run.
      }
    }).rejects.toMatchObject({ code: 'ARCHIVE_LIMIT' })
  })

  it('rejects trailing bytes after the authenticated end record', async () => {
    const value = entry('empty.txt', new Uint8Array())
    const valid = await collect(
      encodeSyncArchive([value], async function* () {
        yield new Uint8Array()
      }),
    )
    const trailing = new Uint8Array(valid.byteLength + 1)
    trailing.set(valid)
    trailing[trailing.byteLength - 1] = 1
    await expect(async () => {
      for await (const _event of decodeSyncArchive(fragments(trailing, 5))) {
        // Drain the decoder so trailing input is observed.
      }
    }).rejects.toMatchObject({ code: 'ARCHIVE_FORMAT' })
  })
})

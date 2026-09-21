import { describe, expect, it } from 'vitest'
import {
  prepareSourceChunks,
  sha256Hex,
  uploadPreparedSource,
} from '../../src/providers/ocbox/source.js'
import { HOSTED_SESSION, errorResponse, jsonResponse, seededApi } from './doubles.js'

describe('hosted source transfer', () => {
  it('chunks deterministically with per-chunk checksums', () => {
    const bytes = new TextEncoder().encode('hello hosted world')
    const first = prepareSourceChunks(bytes, 4)
    const second = prepareSourceChunks(bytes, 4)
    expect(first.checksum).toBe(sha256Hex(bytes))
    expect(first.chunks.map((chunk) => chunk.checksum)).toEqual(
      second.chunks.map((chunk) => chunk.checksum),
    )
    expect(first.totalBytes).toBe(bytes.length)
  })

  it('uploads chunks and verifies the manifest checksum', async () => {
    const bytes = new TextEncoder().encode('source-bytes')
    const prepared = prepareSourceChunks(bytes, 4)
    const seen: string[] = []
    const { api } = await seededApi((input) => {
      const url = String(input)
      seen.push(url)
      if (url.endsWith(`/sessions/${HOSTED_SESSION}/source/manifests`)) {
        return Promise.resolve(jsonResponse({ id: 'manifest_1' }, 201))
      }
      if (url.includes('/chunks/')) {
        return Promise.resolve(
          jsonResponse({
            chunkChecksum: prepared.chunks[Number(url.split('/chunks/')[1])]?.checksum ?? '',
            chunkIndex: 0,
            manifestId: 'manifest_1',
            receivedBytes: 4,
            uploadedChunks: 1,
          }),
        )
      }
      return Promise.resolve(
        jsonResponse({
          checksum: prepared.checksum,
          chunkCount: prepared.chunkCount,
          manifestId: 'manifest_1',
          verified: true,
        }),
      )
    })
    const done = await uploadPreparedSource(api, HOSTED_SESSION, prepared)
    expect(done).toEqual({ manifestId: 'manifest_1', verified: true })
    expect(seen.some((url) => url.includes('/checksum'))).toBe(true)
  })

  it('fails closed on verification mismatch to preserve source integrity', async () => {
    const bytes = new TextEncoder().encode('tampered')
    const prepared = prepareSourceChunks(bytes, 1024)
    const { api } = await seededApi((input) => {
      const url = String(input)
      if (
        url.includes('/source/manifests') &&
        !url.includes('/chunks') &&
        !url.includes('/checksum')
      ) {
        return Promise.resolve(jsonResponse({ id: 'manifest_9' }, 201))
      }
      if (url.includes('/chunks/')) {
        return Promise.resolve(
          jsonResponse({
            chunkChecksum: prepared.chunks[0]?.checksum,
            chunkIndex: 0,
            manifestId: 'manifest_9',
            receivedBytes: 8,
            uploadedChunks: 1,
          }),
        )
      }
      return Promise.resolve(
        jsonResponse({
          checksum: prepared.checksum,
          chunkCount: 1,
          manifestId: 'manifest_9',
          verified: false,
        }),
      )
    })
    await expect(uploadPreparedSource(api, HOSTED_SESSION, prepared)).rejects.toMatchObject({
      code: 'SYNC_INTEGRITY',
    })
  })

  it('retries a transient chunk 503 through maxAttempts before failing', async () => {
    const bytes = new TextEncoder().encode('retry-bytes')
    const prepared = prepareSourceChunks(bytes)
    let chunkCalls = 0
    const { api } = await seededApi((input) => {
      const url = String(input)
      if (url.endsWith(`/sessions/${HOSTED_SESSION}/source/manifests`)) {
        return Promise.resolve(jsonResponse({ id: 'manifest_retry' }, 201))
      }
      if (url.includes('/chunks/')) {
        chunkCalls += 1
        return Promise.resolve(errorResponse('SERVICE_UNAVAILABLE', 503))
      }
      return Promise.resolve(jsonResponse({}))
    })
    await expect(
      uploadPreparedSource(api, HOSTED_SESSION, prepared, {
        maxAttempts: 3,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
    expect(chunkCalls).toBe(3)
  })

  it('recovers when a retryable chunk failure is followed by success', async () => {
    const bytes = new TextEncoder().encode('eventual-success')
    const prepared = prepareSourceChunks(bytes)
    let chunkCalls = 0
    const { api } = await seededApi((input) => {
      const url = String(input)
      if (url.endsWith(`/sessions/${HOSTED_SESSION}/source/manifests`)) {
        return Promise.resolve(jsonResponse({ id: 'manifest_eventual' }, 201))
      }
      if (url.includes('/chunks/')) {
        chunkCalls += 1
        if (chunkCalls === 1) {
          return Promise.resolve(errorResponse('SERVICE_UNAVAILABLE', 503))
        }
        return Promise.resolve(
          jsonResponse({
            chunkChecksum: prepared.chunks[0]?.checksum ?? '',
            chunkIndex: 0,
            manifestId: 'manifest_eventual',
            receivedBytes: bytes.length,
            uploadedChunks: 1,
          }),
        )
      }
      return Promise.resolve(
        jsonResponse({
          checksum: prepared.checksum,
          chunkCount: prepared.chunkCount,
          manifestId: 'manifest_eventual',
          verified: true,
        }),
      )
    })
    const done = await uploadPreparedSource(api, HOSTED_SESSION, prepared, {
      maxAttempts: 3,
      sleep: () => Promise.resolve(),
    })
    expect(chunkCalls).toBe(2)
    expect(done).toEqual({ manifestId: 'manifest_eventual', verified: true })
  })

  it('fails fast on a permanent chunk failure without retrying', async () => {
    const bytes = new TextEncoder().encode('permanent-failure')
    const prepared = prepareSourceChunks(bytes)
    let chunkCalls = 0
    const { api } = await seededApi((input) => {
      const url = String(input)
      if (url.endsWith(`/sessions/${HOSTED_SESSION}/source/manifests`)) {
        return Promise.resolve(jsonResponse({ id: 'manifest_permanent' }, 201))
      }
      if (url.includes('/chunks/')) {
        chunkCalls += 1
        return Promise.resolve(errorResponse('INVALID_REQUEST', 400))
      }
      return Promise.resolve(jsonResponse({}))
    })
    await expect(
      uploadPreparedSource(api, HOSTED_SESSION, prepared, {
        maxAttempts: 3,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SPEC' })
    expect(chunkCalls).toBe(1)
  })
})

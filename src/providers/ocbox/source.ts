import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { SourceManifest } from '../../api/generated/client.js'
import type { OcboxApiClient } from '../../api/client/client.js'
import { toRequestId } from '../../api/client/errors.js'
import { OcboxError } from '../../errors/index.js'
import { newRequestId } from '../../auth/errors.js'
import {
  DEFAULT_RETRY_POLICY,
  resolvePollDelayMilliseconds,
  sleepWithSignal,
  type RetryPolicy,
} from './retry.js'

const HostedSourceManifestPageSchema = z.strictObject({
  data: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        createdAt: z.string().datetime({ offset: true }),
        updatedAt: z.string().datetime({ offset: true }),
        sessionId: z.string().min(1),
        checksum: z.string().regex(/^[a-f0-9]{64}$/),
        chunkCount: z.number().int().min(1).max(10000),
        totalBytes: z.number().int().min(1).max(536870912),
        uploadedChunks: z.number().int().min(0),
        verified: z.boolean(),
      }),
    )
    .max(100),
  nextCursor: z.string().min(1).nullable(),
})

export interface SourceChunk {
  readonly index: number
  readonly bytes: Uint8Array
  readonly checksum: string
}

export interface PreparedSource {
  readonly checksum: string
  readonly chunkCount: number
  readonly totalBytes: number
  readonly chunks: readonly SourceChunk[]
}

const MAX_CHUNKS = 10_000
const DEFAULT_CHUNK_BYTES = 256 * 1024

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Splits archive bytes into checksummed chunks for the manifest protocol.
 * Chunking is deterministic; per-chunk SHA-256 lets the server and the retry
 * path detect partial corruption without re-sending the whole archive.
 */
export function prepareSourceChunks(
  bytes: Uint8Array,
  chunkBytes = DEFAULT_CHUNK_BYTES,
): PreparedSource {
  if (bytes.length === 0) {
    throw new OcboxError({
      code: 'INVALID_SPEC',
      message: 'The source archive is empty',
      requestId: newRequestId(),
    })
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 1024 * 1024) {
    throw new OcboxError({
      code: 'INVALID_SPEC',
      message: 'Source chunks must contain 1 to 1048576 bytes',
      requestId: newRequestId(),
    })
  }
  const chunks: SourceChunk[] = []
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const slice = bytes.slice(offset, offset + chunkBytes)
    if (chunks.length >= MAX_CHUNKS) {
      throw new OcboxError({
        code: 'SYNC_TOO_LARGE',
        message: 'The source archive requires too many chunks',
        requestId: newRequestId(),
      })
    }
    chunks.push({ bytes: slice, checksum: sha256Hex(slice), index: chunks.length })
  }
  return { checksum: sha256Hex(bytes), chunkCount: chunks.length, chunks, totalBytes: bytes.length }
}

export interface UploadSourceOptions {
  readonly deduplicate?: boolean
  readonly signal?: AbortSignal | undefined
  readonly idempotencyKeyFor?: ((scope: string) => string) | undefined
  readonly maxAttempts?: number | undefined
  readonly policy?: RetryPolicy | undefined
  readonly random?: (() => number) | undefined
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new OcboxError({
      code: 'OPERATION_CANCELLED',
      message: 'The hosted source upload was cancelled',
      requestId: newRequestId(),
    })
  }
}

function retryableUploadError(error: unknown): error is OcboxError {
  return error instanceof OcboxError && error.retryable
}

function retryAfterSecondsOf(error: OcboxError): number | null {
  // biome-ignore lint/complexity/useLiteralKeys: Record index signature access
  const value = error.details?.['retryAfterSeconds']
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * Uploads a prepared source with per-chunk checksum verification and bounded
 * retries. Chunk conflicts verify server-side integrity instead of blindly
 * overwriting; a final checksum call proves the assembled manifest.
 */
export async function uploadPreparedSource(
  api: OcboxApiClient,
  hostedSessionId: string,
  prepared: PreparedSource,
  options: UploadSourceOptions = {},
): Promise<{ manifestId: string; verified: boolean; uploaded: boolean }> {
  throwIfCancelled(options.signal)
  let lineage = '[]'
  const keyFor =
    options.idempotencyKeyFor ??
    ((scope: string) =>
      sha256Hex(Buffer.from(JSON.stringify([hostedSessionId, prepared.checksum, lineage, scope]))))
  let existing: SourceManifest | undefined
  if (options.deduplicate === true) {
    let cursor: string | undefined
    const verifiedManifests: SourceManifest[] = []
    const cursors = new Set<string>()
    for (let pageIndex = 0; ; pageIndex += 1) {
      throwIfCancelled(options.signal)
      if (pageIndex >= 100)
        throw new OcboxError({
          code: 'SYNC_FAILED',
          message: 'Hosted source manifest listing exceeded its page limit',
          requestId: newRequestId(),
        })
      const response = await api.generated.listSourceManifests({
        path: { sessionId: hostedSessionId },
        query: { limit: 100, ...(cursor === undefined ? {} : { cursor }) },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      const parsed = HostedSourceManifestPageSchema.safeParse(
        api.assertSuccess('listSourceManifests', response, [200]).body,
      )
      if (!parsed.success) {
        throw new OcboxError({
          code: 'SYNC_INTEGRITY',
          message: 'Invalid hosted source manifest page',
          requestId: newRequestId(),
        })
      }
      const page = parsed.data
      verifiedManifests.push(
        ...page.data.filter((item) => item.verified && item.sessionId === hostedSessionId),
      )
      if (page.nextCursor === null) break
      if (cursors.has(page.nextCursor))
        throw new OcboxError({
          code: 'SYNC_INTEGRITY',
          message: 'Hosted source manifest cursor repeated',
          requestId: newRequestId(),
        })
      cursors.add(page.nextCursor)
      cursor = page.nextCursor
    }
    // A -> B -> A must create a fresh delivery, rather than replay A's old
    // successful apply. Keep the predecessor set stable across interrupted
    // uploads so retries still reuse their manifest and immutable chunks.
    lineage = JSON.stringify(
      verifiedManifests
        .filter((item) => item.checksum !== prepared.checksum)
        .map((item) => [item.id, item.checksum])
        .sort((a, b) => Buffer.compare(Buffer.from(String(a[0])), Buffer.from(String(b[0])))),
    )
    const matching = verifiedManifests
      .filter(
        (item) =>
          item.checksum === prepared.checksum &&
          item.totalBytes === prepared.totalBytes &&
          item.chunkCount === prepared.chunkCount,
      )
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
    // Tied or newer receipts for another snapshot leave the delivered tree
    // ambiguous. Replay the content-addressed upload instead of skipping it.
    if (
      matching &&
      Number.isFinite(Date.parse(matching.updatedAt)) &&
      verifiedManifests.every(
        (item) =>
          item.checksum === prepared.checksum ||
          Date.parse(item.updatedAt) < Date.parse(matching.updatedAt),
      )
    )
      existing = matching
  }
  let manifestId = existing?.id
  if (manifestId === undefined) {
    const manifest = await api.generated.createSourceManifest({
      path: { sessionId: hostedSessionId },
      body: {
        checksum: prepared.checksum,
        chunkCount: prepared.chunkCount,
        totalBytes: prepared.totalBytes,
      },
      idempotencyKey: keyFor('manifest'),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const created = api.assertSuccess('createSourceManifest', manifest, [200, 201])
    manifestId = (created.body as { id: string }).id
  }
  if (typeof manifestId !== 'string' || manifestId.length === 0)
    throw new OcboxError({
      code: 'SYNC_INTEGRITY',
      message: 'Invalid hosted source manifest identity',
      requestId: newRequestId(),
    })
  const maxAttempts = options.maxAttempts ?? 3
  const policy = options.policy ?? DEFAULT_RETRY_POLICY
  const random = options.random ?? Math.random
  const sleep =
    options.sleep ?? ((milliseconds: number) => sleepWithSignal(milliseconds, options.signal))
  for (const chunk of existing === undefined ? prepared.chunks : []) {
    let attempt = 0
    for (;;) {
      throwIfCancelled(options.signal)
      attempt += 1
      try {
        const uploaded = await api.generated.uploadSourceChunk({
          path: { chunkIndex: chunk.index, manifestId },
          body: { checksum: chunk.checksum, data: Buffer.from(chunk.bytes).toString('base64') },
          idempotencyKey: keyFor(`chunk-${chunk.index}`),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
        if (uploaded.status === 409) {
          const receipt = uploaded.body as { chunkChecksum?: unknown }
          if (receipt.chunkChecksum === chunk.checksum) break
          throw api.assertSuccess('uploadSourceChunk', uploaded, [200]).body as never
        }
        api.assertSuccess('uploadSourceChunk', uploaded, [200, 201])
        const receipt = uploaded.body as { chunkChecksum: string }
        if (receipt.chunkChecksum !== chunk.checksum) {
          throw new OcboxError({
            code: 'SYNC_INTEGRITY',
            message: 'The hosted source chunk checksum did not match',
            requestId: toRequestId(uploaded.requestId),
          })
        }
        break
      } catch (error) {
        if (options.signal?.aborted === true) throwIfCancelled(options.signal)
        if (!retryableUploadError(error) || attempt >= maxAttempts) throw error
        await sleep(
          resolvePollDelayMilliseconds({
            attempt,
            policy,
            random,
            retryAfterSeconds: retryAfterSecondsOf(error),
          }),
        )
      }
    }
  }
  throwIfCancelled(options.signal)
  const verified = await api.generated.verifySourceChecksum({
    path: { manifestId },
    idempotencyKey: keyFor('verify'),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const done = api.assertSuccess('verifySourceChecksum', verified, [200])
  const body = done.body as {
    manifestId: string
    verified: boolean
    checksum: string
    chunkCount: number
  }
  if (
    body === null ||
    typeof body !== 'object' ||
    body.verified !== true ||
    body.manifestId !== manifestId ||
    body.checksum !== prepared.checksum ||
    body.chunkCount !== prepared.chunkCount
  ) {
    throw new OcboxError({
      code: 'SYNC_INTEGRITY',
      message: 'The hosted source verification did not match',
      requestId: toRequestId(done.meta.requestId),
    })
  }
  return { manifestId: body.manifestId, verified: true, uploaded: existing === undefined }
}

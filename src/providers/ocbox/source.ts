import { createHash } from 'node:crypto'
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
): Promise<{ manifestId: string; verified: boolean }> {
  throwIfCancelled(options.signal)
  const keyFor =
    options.idempotencyKeyFor ?? ((scope: string) => `${prepared.checksum.slice(0, 16)}-${scope}`)
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
  const manifestId = (created.body as { id: string }).id
  const maxAttempts = options.maxAttempts ?? 3
  const policy = options.policy ?? DEFAULT_RETRY_POLICY
  const random = options.random ?? Math.random
  const sleep =
    options.sleep ?? ((milliseconds: number) => sleepWithSignal(milliseconds, options.signal))
  for (const chunk of prepared.chunks) {
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
  const body = done.body as { manifestId: string; verified: boolean }
  if (!body.verified) {
    throw new OcboxError({
      code: 'SYNC_INTEGRITY',
      message: 'The hosted source verification did not match',
      requestId: toRequestId(done.meta.requestId),
    })
  }
  return { manifestId: body.manifestId, verified: true }
}

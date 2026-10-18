import { CAS_LIMITS, CasResultSchema, type CasTransport, type CasResult } from './cas-contract.js'
import { casError, readCasBlob, type CasSnapshot } from './cas-snapshot.js'
import { CasPlanRefused, casRefusal } from '../providers/ocbox/cas.js'
import { sleepWithSignal } from '../providers/ocbox/retry.js'

export interface CasProgress {
  phase: 'scan' | 'prepared' | 'plan' | 'upload' | 'apply' | 'complete'
  files?: number
  pages?: number
  uploadedBlobs?: number
  uploadedBytes?: number
}
export interface CasTransferOptions {
  signal?: AbortSignal | undefined
  onProgress?: ((event: CasProgress) => void) | undefined
  fetcher?: typeof fetch
  pause?: (ms: number) => Promise<void>
  now?: () => number
}

/** Four uploads at a time; wait for every active worker before releasing the state lock. */
async function parallel<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0,
    failure: unknown
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(CAS_LIMITS.uploadConcurrency, items.length) }, async () => {
      while (!failure) {
        const item = items[cursor++]
        if (item === undefined) return
        try {
          await work(item)
        } catch (error) {
          failure = error
          throw error
        }
      }
    }),
  )
  const rejected = results.find((r) => r.status === 'rejected')
  if (rejected?.status === 'rejected') throw rejected.reason
}

/** Capabilities are opaque HTTPS URLs (HTTP only on loopback); never attach API credentials. */
function uploadTarget(input: string): string {
  try {
    const url = new URL(input)
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    )
      throw new Error()
    return input
  } catch {
    throw casError('SYNC_INTEGRITY', 'Source sync returned an invalid upload capability')
  }
}

/** Plan every page, PUT missing blobs, then replay apply until a matching terminal receipt. */
export async function syncCasSnapshot(
  snapshot: CasSnapshot,
  cache: string,
  transport: CasTransport,
  options: CasTransferOptions = {},
): Promise<{ uploadedBlobs: number; uploadedBytes: number; planId: string }> {
  const fetcher = options.fetcher ?? fetch,
    pause = options.pause ?? ((ms) => sleepWithSignal(ms, options.signal)),
    now = options.now ?? Date.now
  const uploaded = new Set<string>()
  let uploadedBytes = 0,
    planId: string | undefined
  const check = () => {
    if (options.signal?.aborted)
      throw casError('OPERATION_CANCELLED', 'Source sync was cancelled; rerun push to resume')
  }
  const receipt = (value: CasResult) => {
    const parsed = CasResultSchema.safeParse(value)
    if (!parsed.success || (planId && planId !== parsed.data.planId))
      throw casError('SYNC_INTEGRITY', 'Source sync receipt did not match its plan')
    planId = parsed.data.planId
    if (parsed.data.state === 'failed')
      throw new CasPlanRefused(casRefusal(200, parsed.data.reason))
    return parsed.data
  }
  for (const page of snapshot.pages) {
    check()
    options.onProgress?.({ phase: 'plan', pages: page.index + 1 })
    const reply = receipt(
      await transport.call({
        operation: 'plan',
        manifest: snapshot.manifest,
        page,
        idempotencyKey: `cas-${snapshot.manifest.syncId}-p${page.index}`,
      }),
    )
    // A replay after apply/response loss may already be terminal; still verify all page receipts.
    const missing = reply.missing ?? []
    if (reply.state !== 'uploading' && missing.length)
      throw casError('SYNC_INTEGRITY', 'Source sync returned inconsistent upload instructions')
    const seen = new Set<string>()
    for (const blob of missing) {
      const declared = page.blobs.find((b) => b.hash === blob.hash)
      if (!declared || declared.size !== blob.size || seen.has(blob.hash))
        throw casError('SYNC_INTEGRITY', 'Source sync requested an undeclared blob')
      seen.add(blob.hash)
      uploadTarget(blob.url)
    }
    await parallel(missing, async (blob) => {
      if (uploaded.has(blob.hash)) return
      check()
      let bytes: Buffer
      try {
        bytes = await readCasBlob(cache, blob)
      } catch {
        throw casError('SYNC_INTEGRITY', 'A local source blob is missing or corrupt; rerun push')
      }
      for (let attempt = 1; ; attempt++) {
        check()
        let response: Response | undefined
        try {
          response = await fetcher(blob.url, {
            method: 'PUT',
            body: bytes,
            redirect: 'error',
            credentials: 'omit',
            signal: options.signal
              ? AbortSignal.any([options.signal, AbortSignal.timeout(CAS_LIMITS.uploadTimeoutMs)])
              : AbortSignal.timeout(CAS_LIMITS.uploadTimeoutMs),
          })
          await response.body?.cancel()
        } catch {
          /* retry without exposing capability or transport diagnostics */
        }
        check()
        if (response?.ok) {
          uploaded.add(blob.hash)
          uploadedBytes += blob.size
          options.onProgress?.({ phase: 'upload', uploadedBlobs: uploaded.size, uploadedBytes })
          return
        }
        if (response && response.status !== 429 && response.status < 500)
          throw casRefusal(response.status)
        if (attempt >= CAS_LIMITS.attempts)
          throw casError('SYNC_FAILED', 'Source upload was interrupted; rerun push to resume')
        await pause(CAS_LIMITS.retryMs * 2 ** (attempt - 1))
      }
    })
  }
  if (!planId) throw casError('SYNC_INTEGRITY', 'Source sync did not return a plan')
  const deadline = now() + CAS_LIMITS.applyTimeoutMs
  for (;;) {
    check()
    if (now() >= deadline)
      throw casError(
        'OPERATION_TIMEOUT',
        'Source apply did not finish in time; rerun push to resume',
      )
    options.onProgress?.({ phase: 'apply' })
    const reply = receipt(
      await transport.call({
        operation: 'apply',
        planId,
        idempotencyKey: `cas-${snapshot.manifest.syncId}-apply`,
      }),
    )
    if (reply.state === 'succeeded') {
      options.onProgress?.({ phase: 'complete', uploadedBlobs: uploaded.size, uploadedBytes })
      return { planId, uploadedBlobs: uploaded.size, uploadedBytes }
    }
    if (reply.state !== 'pending')
      throw casError('SYNC_INTEGRITY', 'Source apply returned an unexpected state')
    await pause(Math.min(CAS_LIMITS.retryMs, deadline - now()))
  }
}

import { z } from 'zod'
import type { OcboxApiClient } from '../../api/client/client.js'
import { OcboxError } from '../../errors/index.js'
import { CAS_LIMITS, CasResultSchema, type CasTransport } from '../../sync/cas-contract.js'
import { casError } from '../../sync/cas-snapshot.js'
import { sleepWithSignal } from './retry.js'

/** Terminal refusal starts a new plan on the next push, preserving cached blobs. */
export class CasPlanRefused extends OcboxError {
  constructor(error: OcboxError) {
    super({ code: error.code, message: error.message, requestId: error.requestId })
  }
}

/** Maps only recognized public categories; server text and capabilities never enter errors. */
export function casRefusal(status: number, reason?: string): OcboxError {
  if (status === 401) return casError('AUTH_REQUIRED', 'Sign in again before syncing source')
  if (status === 403) return casError('AUTH_FORBIDDEN', 'Source sync was refused for this Session')
  if (status === 404)
    return casError(
      'CAPABILITY_UNSUPPORTED',
      'Source sync v2 is unavailable for this Session or API',
    )
  if (status === 413 || reason === 'disk_full')
    return casError('SYNC_TOO_LARGE', 'Source sync exceeds the available size limit')
  if (reason === 'plan_expired')
    return casError('SYNC_FAILED', 'The source sync plan expired; retry the push')
  if (reason === 'blob_hash_mismatch' || reason === 'manifest_invalid')
    return casError('SYNC_INTEGRITY', 'Source sync failed integrity validation')
  if (status === 409 || reason === 'path_conflict' || reason === 'workspace_busy')
    return casError(
      'SYNC_CONFLICT',
      'Source sync conflicts with the workspace; resolve it and retry',
    )
  if (status === 429)
    return casError('PROVIDER_RATE_LIMIT', 'Source sync is rate limited; retry later')
  return casError('SYNC_FAILED', 'Source sync was refused or could not complete; retry the push')
}

/** Control calls use the normal origin-bound credential/refresh boundary. */
export function createCasTransport(
  api: OcboxApiClient,
  sessionId: string,
  signal?: AbortSignal,
): CasTransport {
  return {
    sessionId,
    scope: JSON.stringify([api.issuer, sessionId]),
    async call(request) {
      for (let attempt = 1; ; attempt++) {
        try {
          const common = {
            path: { sessionId },
            idempotencyKey: request.idempotencyKey,
            ...(signal ? { signal } : {}),
          }
          const response =
            request.operation === 'plan'
              ? await api.generated.planSourceCas({
                  ...common,
                  body: { version: 2, manifest: request.manifest, page: request.page },
                })
              : await api.generated.applySourceCas({
                  ...common,
                  body: { version: 2, planId: request.planId },
                })
          if (response.status !== 200 && response.status !== 202) {
            const error = z
              .object({ error: z.object({ reason: z.string().max(128).optional() }) })
              .safeParse(response.body)
            const refused = casRefusal(
              response.status,
              error.success ? error.data.error.reason : undefined,
            )
            if ([409, 410, 422].includes(response.status)) throw new CasPlanRefused(refused)
            throw refused
          }
          const parsed = CasResultSchema.safeParse(response.body)
          if (!parsed.success)
            throw casError('SYNC_INTEGRITY', 'Source sync returned an invalid receipt')
          if (parsed.data.state === 'failed')
            throw new CasPlanRefused(casRefusal(200, parsed.data.reason))
          return parsed.data
        } catch (error) {
          if (signal?.aborted)
            throw casError('OPERATION_CANCELLED', 'Source sync was cancelled; rerun push to resume')
          if (!(error instanceof OcboxError))
            throw casError('SYNC_FAILED', 'Source sync control request failed')
          if (
            error instanceof CasPlanRefused ||
            !error.retryable ||
            attempt >= CAS_LIMITS.attempts ||
            error.code === 'SYNC_INTEGRITY'
          )
            throw error
          await sleepWithSignal(CAS_LIMITS.retryMs * 2 ** (attempt - 1), signal)
        }
      }
    },
  }
}

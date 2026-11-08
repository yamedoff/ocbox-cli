import { z } from 'zod'
import type { OcboxApiClient } from '../../api/client/client.js'
import { OcboxError } from '../../errors/index.js'
import {
  CAS_LIMITS,
  CasCheckResultSchema,
  type CasFastApplyRequest,
  CasFastApplyResultSchema,
  CasPullResultSchema,
  CasResultSchema,
  CasSnapshotPageResultSchema,
  CasSnapshotResultSchema,
  type CasSourceTransport,
} from '../../sync/cas-contract.js'
import { casError } from '../../sync/cas-snapshot.js'
import { sleepWithSignal } from './retry.js'

/** Terminal refusal starts a new plan on the next push, preserving cached blobs. */
export class CasPlanRefused extends OcboxError {
  constructor(error: OcboxError) {
    super({ code: error.code, message: error.message, requestId: error.requestId })
  }
}

/** Maps only recognized public categories; server text and capabilities never enter errors. */
export function casRefusal(
  status: number,
  reason?: string,
  operation?: 'pull' | 'snapshot' | 'snapshot-page',
): OcboxError {
  if (status === 401) return casError('AUTH_REQUIRED', 'Sign in again before syncing source')
  if (status === 403) return casError('AUTH_FORBIDDEN', 'Source sync was refused for this Session')
  if (status === 404) {
    if (operation === 'pull')
      return casError('CAPABILITY_UNSUPPORTED', 'Server does not support sync pull yet')
    if (operation === 'snapshot' || operation === 'snapshot-page')
      return casError('CAPABILITY_UNSUPPORTED', 'Server does not support source snapshots yet')
    return casError(
      'CAPABILITY_UNSUPPORTED',
      'Source sync v2 is unavailable for this Session or API',
    )
  }
  if (status === 413 || reason === 'disk_full')
    return casError('SYNC_TOO_LARGE', 'Source sync exceeds the available size limit')
  if (reason === 'plan_expired')
    return casError('SYNC_FAILED', 'The source sync plan expired; retry the push')
  if (reason === 'snapshot_missing')
    return casError('SYNC_FAILED', 'No source snapshot is available; run ocbox sync diff first')
  if (reason === 'snapshot_failed')
    return casError('SYNC_FAILED', 'The source snapshot failed; retry sync diff')
  if (reason === 'source_tree_changed')
    return casError(
      'SYNC_CONFLICT',
      'The box workspace changed after the snapshot; run ocbox sync diff and retry',
    )
  if (reason === 'source_snapshot_requires_cas')
    return casError('CAPABILITY_UNSUPPORTED', 'Source read-back requires a CAS v2 box')
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
): CasSourceTransport {
  async function readCall<Result>(
    operation: 'pull' | 'snapshot' | 'snapshot-page',
    invoke: () => Promise<{ status: number; body: unknown }>,
    schema: z.ZodType<Result>,
  ): Promise<Result> {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await invoke()
        if (response.status !== 200 && response.status !== 202) {
          const error = z
            .object({ error: z.object({ reason: z.string().max(128).optional() }) })
            .safeParse(response.body)
          throw casRefusal(
            response.status,
            error.success ? error.data.error.reason : undefined,
            operation,
          )
        }
        const parsed = schema.safeParse(response.body)
        if (!parsed.success)
          throw casError('SYNC_INTEGRITY', 'Source read-back returned an invalid receipt')
        if ((parsed.data as { state?: string }).state === 'failed')
          throw casRefusal(200, (parsed.data as { reason?: string }).reason, operation)
        return parsed.data
      } catch (error) {
        if (signal?.aborted)
          throw casError('OPERATION_CANCELLED', 'Source sync was cancelled; retry the command')
        if (!(error instanceof OcboxError))
          throw casError('SYNC_FAILED', 'Source read-back control request failed')
        if (!error.retryable || attempt >= CAS_LIMITS.attempts || error.code === 'SYNC_INTEGRITY')
          throw error
        await sleepWithSignal(CAS_LIMITS.retryMs * 2 ** (attempt - 1), signal)
      }
    }
  }
  async function fastCall<Result>(
    invoke: () => Promise<{ status: number; body: unknown }>,
    schema: z.ZodType<Result>,
  ): Promise<Result> {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await invoke()
        if (response.status !== 200) {
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
        const parsed = schema.safeParse(response.body)
        if (!parsed.success)
          throw casError('SYNC_INTEGRITY', 'Source sync returned an invalid receipt')
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
  }
  return {
    sessionId,
    scope: JSON.stringify([api.issuer, sessionId]),
    check(fingerprint, changedPaths, idempotencyKey) {
      return fastCall(
        () =>
          api.generated.checkSourceCas({
            path: { sessionId },
            body: {
              version: 3,
              fingerprint,
              ...(changedPaths === undefined ? {} : { changedPaths: [...changedPaths] }),
            },
            idempotencyKey,
            ...(signal ? { signal } : {}),
          }),
        CasCheckResultSchema,
      )
    },
    fastApply(request: CasFastApplyRequest, idempotencyKey) {
      return fastCall(
        () =>
          api.generated.fastApplySourceCas({
            path: { sessionId },
            body: {
              version: 3,
              fingerprint: request.fingerprint,
              files: [...request.files],
              blobs: [...request.blobs],
              ...(request.deletedPaths === undefined
                ? {}
                : { deletedPaths: [...request.deletedPaths] }),
            },
            idempotencyKey,
            ...(signal ? { signal } : {}),
          }),
        CasFastApplyResultSchema,
      )
    },
    snapshot(refresh, idempotencyKey) {
      return readCall(
        'snapshot',
        () =>
          api.generated.createSourceSnapshot({
            path: { sessionId },
            body: { version: 2, refresh },
            idempotencyKey,
            ...(signal ? { signal } : {}),
          }),
        CasSnapshotResultSchema,
      )
    },
    snapshotPage(snapshotId, index, idempotencyKey) {
      return readCall(
        'snapshot-page',
        () =>
          api.generated.readSourceSnapshotPage({
            path: { sessionId },
            body: { version: 2, snapshotId, index },
            idempotencyKey,
            ...(signal ? { signal } : {}),
          }),
        CasSnapshotPageResultSchema,
      )
    },
    pull(snapshotId, paths, idempotencyKey, cursor) {
      return readCall(
        'pull',
        () =>
          api.generated.createSourcePull({
            path: { sessionId },
            body: {
              version: 2,
              snapshotId,
              paths: [...paths],
              ...(cursor === undefined ? {} : { cursor }),
            },
            idempotencyKey,
            ...(signal ? { signal } : {}),
          }),
        CasPullResultSchema,
      )
    },
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

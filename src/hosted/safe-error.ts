import { z } from 'zod'

/**
 * The public `SafeError` the running service publishes. The pinned OpenAPI
 * document predates `reasonCode`, `retryable`, `nextStep` and the newer
 * identifier fields, so this schema accepts the current fields and ignores
 * any field a later server adds; the values the CLI renders stay bounded.
 */
export const SafeErrorSchema = z.looseObject({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(1024),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  reason: z.string().min(1).max(128).optional(),
  reasonCode: z.string().min(1).max(128).optional(),
  retryable: z.boolean().optional(),
  nextStep: z.string().max(1024).optional(),
  executionId: z.string().max(128).optional(),
  runningExecutionIds: z.array(z.string().max(128)).max(16).optional(),
  limit: z.number().int().min(1).max(16).optional(),
  planId: z.string().max(128).optional(),
  snapshotId: z.string().max(128).optional(),
})
export type SafeError = z.infer<typeof SafeErrorSchema>

/**
 * The product reason a user should see. The older provider category wins when
 * present; a current server product failure answers with `reasonCode` only.
 */
export function safeErrorReason(error: SafeError | null | undefined): string | undefined {
  return error?.reason ?? error?.reasonCode
}

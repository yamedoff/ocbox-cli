import { z } from 'zod'
import {
  IdempotencyKeySchema,
  OperationIdSchema,
  ProviderSandboxIdSchema,
  RequestIdSchema,
  SandboxIdSchema,
  SessionIdSchema,
} from './ids.js'
import { UtcTimestampSchema } from './timestamps.js'

export const OPERATION_ACTIONS = [
  'create',
  'start',
  'pause',
  'stop',
  'resume',
  'destroy',
  'exec',
  'exec_cancel',
  'file_write',
  'file_mkdir',
  'file_remove',
  'file_move',
  'source_apply',
  'preview_create',
  'preview_revoke',
] as const

export const OperationActionSchema = z.enum(OPERATION_ACTIONS)
export const OperationStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
])

export const IdempotencyResolutionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('created') }),
  z.strictObject({
    kind: z.literal('replayed_result'),
    originalOperationId: OperationIdSchema,
  }),
  z.strictObject({
    kind: z.literal('adopted_existing'),
    providerSandboxId: ProviderSandboxIdSchema,
    originalOperationId: OperationIdSchema.nullable(),
  }),
])

export const RequestContextSchema = z.strictObject({
  requestId: RequestIdSchema,
  issuedAt: UtcTimestampSchema,
})

/**
 * Required on every provider mutation. Callers generate and persist these
 * values before invoking a provider so retries can replay or adopt safely.
 */
export const OperationContextSchema = RequestContextSchema.extend({
  operationId: OperationIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  attempt: z.number().int().positive().safe(),
})

export const CreateAdoptionPolicySchema = z.strictObject({
  strategy: z.enum(['metadata_search_then_adopt', 'serialize_then_reconcile']),
  metadata: z.strictObject({
    sessionId: SessionIdSchema,
    operationId: OperationIdSchema,
  }),
})

const LIFECYCLE_MUTATIONS = new Set<OperationAction>([
  'create',
  'start',
  'pause',
  'stop',
  'resume',
  'destroy',
])

export const OperationSchema = z
  .strictObject({
    id: OperationIdSchema,
    requestId: RequestIdSchema,
    sessionId: SessionIdSchema,
    sandboxId: SandboxIdSchema.nullable(),
    action: OperationActionSchema,
    status: OperationStatusSchema,
    idempotencyKey: IdempotencyKeySchema,
    idempotencyResolution: IdempotencyResolutionSchema.nullable(),
    providerVerifiedAt: UtcTimestampSchema.nullable(),
    createdAt: UtcTimestampSchema,
    startedAt: UtcTimestampSchema.nullable(),
    completedAt: UtcTimestampSchema.nullable(),
  })
  .superRefine((operation, context) => {
    if (operation.startedAt !== null && operation.startedAt < operation.createdAt) {
      context.addIssue({ code: 'custom', message: 'Operation cannot start before creation' })
    }
    if (
      operation.completedAt !== null &&
      (operation.completedAt < operation.createdAt ||
        (operation.startedAt !== null && operation.completedAt < operation.startedAt))
    ) {
      context.addIssue({ code: 'custom', message: 'Operation completion time is out of order' })
    }

    if (operation.status === 'pending') {
      if (operation.startedAt !== null || operation.completedAt !== null) {
        context.addIssue({
          code: 'custom',
          message: 'Pending Operation cannot have execution times',
        })
      }
    } else if (operation.status === 'running') {
      if (operation.startedAt === null || operation.completedAt !== null) {
        context.addIssue({
          code: 'custom',
          message: 'Running Operation requires startedAt and no completedAt',
        })
      }
    } else if (operation.completedAt === null) {
      context.addIssue({ code: 'custom', message: 'Terminal Operation requires completedAt' })
    }

    if (
      operation.status === 'succeeded' &&
      LIFECYCLE_MUTATIONS.has(operation.action) &&
      operation.providerVerifiedAt === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['providerVerifiedAt'],
        message: 'Successful lifecycle Operation requires provider verification',
      })
    }
    if (
      operation.providerVerifiedAt !== null &&
      (operation.status !== 'succeeded' || !LIFECYCLE_MUTATIONS.has(operation.action))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['providerVerifiedAt'],
        message: 'Provider verification belongs only to a successful lifecycle Operation',
      })
    }
    if (
      operation.providerVerifiedAt !== null &&
      (operation.providerVerifiedAt < (operation.startedAt ?? operation.createdAt) ||
        (operation.completedAt !== null && operation.providerVerifiedAt > operation.completedAt))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['providerVerifiedAt'],
        message: 'Provider verification must occur during the Operation',
      })
    }
    if (operation.status === 'succeeded' && operation.idempotencyResolution === null) {
      context.addIssue({
        code: 'custom',
        path: ['idempotencyResolution'],
        message: 'Successful mutation requires an idempotency resolution',
      })
    }
    if (operation.status !== 'succeeded' && operation.idempotencyResolution !== null) {
      context.addIssue({
        code: 'custom',
        path: ['idempotencyResolution'],
        message: 'Only a successful mutation records an idempotency resolution',
      })
    }
    if (operation.action !== 'create' && operation.sandboxId === null) {
      context.addIssue({
        code: 'custom',
        path: ['sandboxId'],
        message: `Operation ${operation.action} requires a Sandbox ID`,
      })
    }
    if (
      operation.action === 'create' &&
      operation.status === 'succeeded' &&
      operation.sandboxId === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sandboxId'],
        message: 'Successful create Operation requires the created Sandbox ID',
      })
    }
  })

export type OperationAction = z.infer<typeof OperationActionSchema>
export type OperationStatus = z.infer<typeof OperationStatusSchema>
export type IdempotencyResolution = z.infer<typeof IdempotencyResolutionSchema>
export type RequestContext = z.infer<typeof RequestContextSchema>
export type OperationContext = z.infer<typeof OperationContextSchema>
export type CreateAdoptionPolicy = z.infer<typeof CreateAdoptionPolicySchema>
export type Operation = z.infer<typeof OperationSchema>

import { z } from 'zod'

/**
 * Runtime schemas for the pinned hosted `/v1` wire contract. The generated
 * client returns `unknown` bodies, so the hosted adapter validates the exact
 * shapes it consumes before mapping them onto the provider-neutral contracts.
 * These schemas mirror `openapi/openapi.yaml`; they never cross into the
 * private provider SDK boundary.
 */

export const HostedSafeErrorSchema = z
  .strictObject({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(512),
    retryAfterSeconds: z.number().int().min(0).optional(),
  })
  .readonly()

export const HostedErrorEnvelopeSchema = z
  .strictObject({
    error: HostedSafeErrorSchema,
    requestId: z.string().min(1).max(128),
  })
  .readonly()

export const HostedResourceLinkSchema = z
  .strictObject({
    type: z.enum(['project', 'environment', 'session', 'execution', 'sourceManifest', 'preview']),
    id: z.string().min(1),
  })
  .readonly()

export const HostedOperationStateSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'cancelled',
  'failed',
])

export const HostedOperationSchema = z
  .strictObject({
    id: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    kind: z.string().min(1).max(64),
    projectId: z.string().min(1).nullable(),
    sessionId: z.string().min(1).nullable(),
    state: HostedOperationStateSchema,
    progress: z.number().int().min(0).max(100),
    requestId: z.string().min(1).max(128),
    error: HostedSafeErrorSchema.nullable(),
    resource: HostedResourceLinkSchema.nullable(),
  })
  .readonly()

export const HostedOperationPageSchema = z
  .strictObject({
    data: z.array(HostedOperationSchema).readonly(),
    nextCursor: z.string().nullable(),
  })
  .readonly()

export const HostedSandboxBindingSchema = z
  .strictObject({
    ordinal: z.number().int().min(0),
    role: z.literal('primary'),
    active: z.boolean(),
    state: z.enum(['running', 'stopped']),
    sandboxId: z.string().min(1),
    boundAt: z.string().min(1),
    releasedAt: z.string().min(1).nullable(),
  })
  .readonly()

export const HostedSessionSchema = z
  .strictObject({
    id: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    projectId: z.string().min(1),
    requestedSpec: z.record(z.string(), z.unknown()),
    effectiveSpec: z.record(z.string(), z.unknown()),
    normalizedState: z.enum([
      'created',
      'starting',
      'running',
      'pausing',
      'paused',
      'stopping',
      'stopped',
      'destroying',
      'destroyed',
    ]),
    rawState: z.string().min(1),
    sandboxes: z.array(HostedSandboxBindingSchema).readonly(),
    primarySandboxId: z.string().min(1).nullable(),
  })
  .readonly()

export const HostedExecutionStateSchema = z.enum([
  'pending',
  'running',
  'completed',
  'cancelled',
  'failed',
])

export const HostedExecutionSchema = z
  .strictObject({
    id: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    sessionId: z.string().min(1),
    sandboxId: z.string().min(1).nullable(),
    state: HostedExecutionStateSchema,
    command: z.string().min(1).max(8_192),
    exitCode: z.number().int().nullable(),
    failureKind: z.enum(['command', 'infrastructure']).nullable(),
    failure: HostedSafeErrorSchema.nullable(),
    truncated: z.boolean(),
    outputBytes: z.number().int().min(0),
    outputLimitBytes: z.number().int().min(1),
  })
  .readonly()

export const HostedExecutionEventKindSchema = z.enum([
  'started',
  'stdout',
  'stderr',
  'progress',
  'completed',
  'failed',
  'cancelled',
])

export const HostedExecutionEventSchema = z
  .strictObject({
    sequence: z.number().int().min(0),
    at: z.string().min(1),
    kind: HostedExecutionEventKindSchema,
    stream: z.enum(['stdout', 'stderr']).nullable(),
    message: z.string().max(8_192),
  })
  .readonly()

export const HostedExecutionEventPageSchema = z
  .strictObject({
    data: z.array(HostedExecutionEventSchema).readonly(),
    nextCursor: z.string().nullable(),
  })
  .readonly()

export const HostedCommandResultSchema = z
  .strictObject({
    kind: z.literal('command'),
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.boolean(),
    outputBytes: z.number().int().min(0),
    outputLimitBytes: z.number().int().min(1),
  })
  .readonly()

export const HostedInfrastructureResultSchema = z
  .strictObject({
    kind: z.literal('infrastructure'),
    error: HostedSafeErrorSchema,
  })
  .readonly()

export const HostedCancelledResultSchema = z
  .strictObject({ kind: z.literal('cancelled') })
  .readonly()

export const HostedExecutionResultSchema = z.discriminatedUnion('kind', [
  HostedCommandResultSchema,
  HostedInfrastructureResultSchema,
  HostedCancelledResultSchema,
])

export type HostedSafeError = z.infer<typeof HostedSafeErrorSchema>
export type HostedErrorEnvelope = z.infer<typeof HostedErrorEnvelopeSchema>
export type HostedResourceLink = z.infer<typeof HostedResourceLinkSchema>
export type HostedOperationState = z.infer<typeof HostedOperationStateSchema>
export type HostedOperation = z.infer<typeof HostedOperationSchema>
export type HostedOperationPage = z.infer<typeof HostedOperationPageSchema>
export type HostedSandboxBinding = z.infer<typeof HostedSandboxBindingSchema>
export type HostedSession = z.infer<typeof HostedSessionSchema>
export type HostedExecutionState = z.infer<typeof HostedExecutionStateSchema>
export type HostedExecution = z.infer<typeof HostedExecutionSchema>
export type HostedExecutionEventKind = z.infer<typeof HostedExecutionEventKindSchema>
export type HostedExecutionEvent = z.infer<typeof HostedExecutionEventSchema>
export type HostedExecutionEventPage = z.infer<typeof HostedExecutionEventPageSchema>
export type HostedCommandResult = z.infer<typeof HostedCommandResultSchema>
export type HostedInfrastructureResult = z.infer<typeof HostedInfrastructureResultSchema>
export type HostedCancelledResult = z.infer<typeof HostedCancelledResultSchema>
export type HostedExecutionResult = z.infer<typeof HostedExecutionResultSchema>

export function isTerminalOperationState(state: HostedOperationState): boolean {
  return state === 'succeeded' || state === 'cancelled' || state === 'failed'
}

export function isTerminalExecutionState(state: HostedExecutionState): boolean {
  return state === 'completed' || state === 'cancelled' || state === 'failed'
}

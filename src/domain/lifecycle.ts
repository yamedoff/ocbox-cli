import { z } from 'zod'
import { OperationIdSchema, type OperationId } from './ids.js'
import { UtcTimestampSchema, type UtcTimestamp } from './timestamps.js'

export const SESSION_STATES = [
  'creating',
  'active',
  'pausing',
  'paused',
  'stopping',
  'stopped',
  'resuming',
  'destroying',
  'destroyed',
  'error',
] as const

export const SessionStateSchema = z.enum(SESSION_STATES)
export type SessionState = z.infer<typeof SessionStateSchema>

/**
 * Exhaustive legal transition table for the OpenCloudBox-owned Session state
 * machine. Rollbacks from transitional states represent a provider-verified
 * return to the previous stable state after a failed mutation.
 */
export const SESSION_TRANSITIONS = {
  creating: ['active', 'destroying', 'error'],
  active: ['pausing', 'stopping', 'destroying', 'error'],
  pausing: ['paused', 'active', 'destroying', 'error'],
  paused: ['resuming', 'stopping', 'destroying', 'error'],
  stopping: ['stopped', 'active', 'paused', 'destroying', 'error'],
  stopped: ['resuming', 'destroying', 'error'],
  resuming: ['active', 'paused', 'stopped', 'destroying', 'error'],
  destroying: ['destroyed', 'error'],
  destroyed: [],
  error: ['active', 'paused', 'stopped', 'destroying', 'destroyed'],
} as const satisfies Readonly<Record<SessionState, readonly SessionState[]>>

export function canTransitionSessionState(from: SessionState, to: SessionState): boolean {
  return (SESSION_TRANSITIONS[from] as readonly SessionState[]).includes(to)
}

export const PROVIDER_LIFECYCLE_STATES = [
  'creating',
  'running',
  'pausing',
  'paused',
  'stopping',
  'stopped',
  'deleting',
  'deleted',
  'error',
  'unknown',
] as const

export const ProviderLifecycleStateSchema = z.enum(PROVIDER_LIFECYCLE_STATES)
export type ProviderLifecycleState = z.infer<typeof ProviderLifecycleStateSchema>

export const PROVIDER_DESIRED_STATES = ['running', 'paused', 'stopped', 'deleted'] as const
export const ProviderDesiredStateSchema = z.enum(PROVIDER_DESIRED_STATES)
export type ProviderDesiredState = z.infer<typeof ProviderDesiredStateSchema>

export const ProviderLifecycleTimestampsSchema = z
  .strictObject({
    creationStartedAt: UtcTimestampSchema.nullable(),
    runningAt: UtcTimestampSchema.nullable(),
    pauseStartedAt: UtcTimestampSchema.nullable(),
    pausedAt: UtcTimestampSchema.nullable(),
    stopStartedAt: UtcTimestampSchema.nullable(),
    stoppedAt: UtcTimestampSchema.nullable(),
    deletionStartedAt: UtcTimestampSchema.nullable(),
    deletedAt: UtcTimestampSchema.nullable(),
    errorAt: UtcTimestampSchema.nullable(),
    lastTransitionAt: UtcTimestampSchema.nullable(),
  })
  .superRefine((timestamps, context) => {
    const orderedPairs = [
      ['creationStartedAt', 'runningAt'],
      ['pauseStartedAt', 'pausedAt'],
      ['stopStartedAt', 'stoppedAt'],
      ['deletionStartedAt', 'deletedAt'],
    ] as const

    for (const [startedKey, completedKey] of orderedPairs) {
      const startedAt = timestamps[startedKey]
      const completedAt = timestamps[completedKey]
      if (startedAt !== null && completedAt !== null && completedAt < startedAt) {
        context.addIssue({
          code: 'custom',
          path: [completedKey],
          message: `${completedKey} cannot precede ${startedKey}`,
        })
      }
    }
  })

export type ProviderLifecycleTimestamps = z.infer<typeof ProviderLifecycleTimestampsSchema>

export const ProviderLifecycleObservationSchema = z
  .strictObject({
    normalizedState: ProviderLifecycleStateSchema,
    rawState: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim().length > 0, 'Raw provider state cannot be blank'),
    desiredState: ProviderDesiredStateSchema.nullable(),
    reason: z
      .string()
      .min(1)
      .max(1_000)
      .refine((value) => value.trim().length > 0, 'Provider reason cannot be blank')
      .nullable(),
    observedAt: UtcTimestampSchema,
    lifecycleTimestamps: ProviderLifecycleTimestampsSchema,
  })
  .superRefine((observation, context) => {
    for (const [name, timestamp] of Object.entries(observation.lifecycleTimestamps)) {
      if (timestamp !== null && timestamp > observation.observedAt) {
        context.addIssue({
          code: 'custom',
          path: ['lifecycleTimestamps', name],
          message: 'Lifecycle timestamp cannot be later than the provider observation',
        })
      }
    }
  })

export type ProviderLifecycleObservation = z.infer<typeof ProviderLifecycleObservationSchema>

export interface SessionTransitionEvidence {
  readonly operationId?: OperationId
  readonly providerObservation?: ProviderLifecycleObservation
}

export const SessionTransitionEvidenceSchema = z.strictObject({
  operationId: OperationIdSchema.optional(),
  providerObservation: ProviderLifecycleObservationSchema.optional(),
})

const TRANSITIONAL_SESSION_STATES = new Set<SessionState>([
  'creating',
  'pausing',
  'stopping',
  'resuming',
  'destroying',
])
const VERIFIED_SUCCESS_STATES = new Set<SessionState>(['active', 'paused', 'stopped', 'destroyed'])

/**
 * Rollback and reconciliation edges are public contract, not an escape hatch.
 * Each edge requires a provider observation aligned to its stable target. An
 * Operation ID is additionally required when recovering from an in-flight
 * transition; `error` recovery is observation-driven reconciliation.
 */
export const SESSION_RECOVERY_TRANSITIONS = {
  pausing: ['active'],
  stopping: ['active', 'paused'],
  resuming: ['paused', 'stopped'],
  error: ['active', 'paused', 'stopped', 'destroyed'],
} as const satisfies Partial<Readonly<Record<SessionState, readonly SessionState[]>>>

export function isSessionRecoveryTransition(from: SessionState, to: SessionState): boolean {
  const targets = SESSION_RECOVERY_TRANSITIONS[from as keyof typeof SESSION_RECOVERY_TRANSITIONS]
  return targets === undefined ? false : (targets as readonly SessionState[]).includes(to)
}

const STABLE_SESSION_PROVIDER_STATE = {
  active: 'running',
  paused: 'paused',
  stopped: 'stopped',
  destroyed: 'deleted',
} as const satisfies Readonly<
  Record<
    Extract<SessionState, 'active' | 'paused' | 'stopped' | 'destroyed'>,
    ProviderLifecycleState
  >
>

/**
 * Validates both the graph edge and its required evidence. A provider-backed
 * terminal success may not be reported before a fresh provider observation.
 */
export function assertSessionTransition(
  from: SessionState,
  to: SessionState,
  evidence: SessionTransitionEvidence,
): void {
  // Parse at the decision boundary so JavaScript callers cannot forge a
  // partial observation and use its normalizedState as a recovery escape hatch.
  const verifiedEvidence = SessionTransitionEvidenceSchema.parse(evidence)

  if (!canTransitionSessionState(from, to)) {
    throw new TypeError(`Illegal Session transition: ${from} -> ${to}`)
  }

  if (
    (TRANSITIONAL_SESSION_STATES.has(from) || TRANSITIONAL_SESSION_STATES.has(to)) &&
    verifiedEvidence.operationId === undefined
  ) {
    throw new TypeError(`Session transition ${from} -> ${to} requires an Operation ID`)
  }

  if (VERIFIED_SUCCESS_STATES.has(to)) {
    const observation = verifiedEvidence.providerObservation
    if (observation === undefined) {
      throw new TypeError(`Session transition to ${to} requires a provider observation`)
    }

    const expectedProviderState =
      STABLE_SESSION_PROVIDER_STATE[to as keyof typeof STABLE_SESSION_PROVIDER_STATE]
    if (observation.normalizedState !== expectedProviderState) {
      throw new TypeError(
        `Session state ${to} requires provider state ${expectedProviderState}, received ${observation.normalizedState}`,
      )
    }
  }
}

export const LIFECYCLE_ACTIONS = ['create', 'start', 'pause', 'stop', 'resume', 'destroy'] as const
export const LifecycleActionSchema = z.enum(LIFECYCLE_ACTIONS)
export type LifecycleAction = z.infer<typeof LifecycleActionSchema>

export const RETENTION_OUTCOMES = ['created', 'preserved', 'discarded', 'restarted'] as const
export const RetentionOutcomeSchema = z.enum(RETENTION_OUTCOMES)
export type RetentionOutcome = z.infer<typeof RetentionOutcomeSchema>

export interface LifecycleRetentionSemantics {
  readonly processes: RetentionOutcome
  readonly memory: RetentionOutcome
  readonly filesystem: RetentionOutcome
}

/** Product semantics, independent of provider-specific operation names. */
export const LIFECYCLE_RETENTION = {
  create: { processes: 'created', memory: 'created', filesystem: 'created' },
  start: { processes: 'restarted', memory: 'discarded', filesystem: 'preserved' },
  pause: { processes: 'preserved', memory: 'preserved', filesystem: 'preserved' },
  stop: { processes: 'discarded', memory: 'discarded', filesystem: 'preserved' },
  resume: { processes: 'preserved', memory: 'preserved', filesystem: 'preserved' },
  destroy: { processes: 'discarded', memory: 'discarded', filesystem: 'discarded' },
} as const satisfies Readonly<Record<LifecycleAction, LifecycleRetentionSemantics>>

export type ProviderStateMapping = Readonly<Record<string, ProviderLifecycleState>>

/**
 * Normalizes a raw provider state without discarding the original value.
 * Mapping keys are matched exactly; unrecognized states become `unknown`.
 */
export function observeProviderLifecycle(input: {
  readonly rawState: string
  readonly mapping: ProviderStateMapping
  readonly desiredState: ProviderDesiredState | null
  readonly reason: string | null
  readonly observedAt: UtcTimestamp
  readonly lifecycleTimestamps: ProviderLifecycleTimestamps
}): ProviderLifecycleObservation {
  const normalizedState = input.mapping[input.rawState] ?? 'unknown'
  return ProviderLifecycleObservationSchema.parse({
    normalizedState,
    rawState: input.rawState,
    desiredState: input.desiredState,
    reason: input.reason,
    observedAt: input.observedAt,
    lifecycleTimestamps: input.lifecycleTimestamps,
  })
}

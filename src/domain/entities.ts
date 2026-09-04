import { z } from 'zod'
import {
  BindingIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  ProviderSandboxIdSchema,
  SandboxIdSchema,
  SessionIdSchema,
} from './ids.js'
import {
  ProviderLifecycleObservationSchema,
  SessionStateSchema,
  type SessionState,
} from './lifecycle.js'
import { RequestedEffectiveSpecSchema } from './spec.js'
import { UtcTimestampSchema } from './timestamps.js'

const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/

export const ProjectSchema = z
  .strictObject({
    id: ProjectIdSchema,
    name: z.string().trim().min(1).max(120),
    sessionIds: z.array(SessionIdSchema).readonly(),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .superRefine((project, context) => {
    if (new Set(project.sessionIds).size !== project.sessionIds.length) {
      context.addIssue({ code: 'custom', message: 'Project Session IDs must be unique' })
    }
    if (project.updatedAt < project.createdAt) {
      context.addIssue({ code: 'custom', message: 'Project update cannot precede creation' })
    }
  })

export const SANDBOX_ROLES = ['primary', 'auxiliary'] as const
export const SandboxRoleSchema = z.enum(SANDBOX_ROLES)

export const SessionSandboxBindingSchema = z
  .strictObject({
    id: BindingIdSchema,
    sessionId: SessionIdSchema,
    sandboxId: SandboxIdSchema,
    role: SandboxRoleSchema,
    ordinal: z.number().int().nonnegative().safe(),
    boundAt: UtcTimestampSchema,
    releasedAt: UtcTimestampSchema.nullable(),
  })
  .superRefine((binding, context) => {
    if (binding.releasedAt !== null && binding.releasedAt < binding.boundAt) {
      context.addIssue({
        code: 'custom',
        message: 'A binding cannot be released before it is bound',
      })
    }
  })

const TRANSITIONAL_STATES = new Set<SessionState>([
  'creating',
  'pausing',
  'stopping',
  'resuming',
  'destroying',
])
const VERIFIED_STABLE_STATES = new Set<SessionState>(['active', 'paused', 'stopped', 'destroyed'])

export const SessionSchema = z
  .strictObject({
    id: SessionIdSchema,
    projectId: ProjectIdSchema,
    state: SessionStateSchema,
    bindings: z.array(SessionSandboxBindingSchema).readonly(),
    currentOperationId: OperationIdSchema.nullable(),
    providerVerifiedAt: UtcTimestampSchema.nullable(),
    sandboxDeletionVerifiedAt: UtcTimestampSchema.nullable(),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .superRefine((session, context) => {
    if (session.updatedAt < session.createdAt) {
      context.addIssue({ code: 'custom', message: 'Session update cannot precede creation' })
    }
    if (
      session.providerVerifiedAt !== null &&
      (session.providerVerifiedAt < session.createdAt ||
        session.providerVerifiedAt > session.updatedAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['providerVerifiedAt'],
        message: 'Provider verification must fall within the Session record lifetime',
      })
    }
    if (
      session.sandboxDeletionVerifiedAt !== null &&
      (session.sandboxDeletionVerifiedAt < session.createdAt ||
        session.sandboxDeletionVerifiedAt > session.updatedAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sandboxDeletionVerifiedAt'],
        message: 'Sandbox deletion verification must fall within the Session record lifetime',
      })
    }

    const bindingIds = new Set<string>()
    for (const [index, binding] of session.bindings.entries()) {
      if (bindingIds.has(binding.id)) {
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'id'],
          message: 'Binding IDs must be unique within a Session',
        })
      }
      bindingIds.add(binding.id)
      if (binding.sessionId !== session.id) {
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'sessionId'],
          message: 'Every binding must belong to the enclosing Session',
        })
      }
      if (binding.ordinal !== index) {
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'ordinal'],
          message: 'Bindings must be ordered with contiguous ordinals',
        })
      }
      if (binding.boundAt < session.createdAt || binding.boundAt > session.updatedAt) {
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'boundAt'],
          message: 'Binding time must fall within the Session record lifetime',
        })
      }
      if (binding.releasedAt !== null && binding.releasedAt > session.updatedAt) {
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'releasedAt'],
          message: 'Binding release cannot be later than the Session update',
        })
      }
    }

    const activeBindings = session.bindings.filter((binding) => binding.releasedAt === null)
    if (activeBindings.length > 1) {
      context.addIssue({
        code: 'custom',
        path: ['bindings'],
        message: 'v0.1 permits at most one active Sandbox binding',
      })
    }
    if (activeBindings.some((binding) => binding.role !== 'primary')) {
      context.addIssue({
        code: 'custom',
        path: ['bindings'],
        message: 'v0.1 permits only an active primary Sandbox binding',
      })
    }

    if (activeBindings.length === 0) {
      const isProvisioning = session.state === 'creating'
      const isVerifiedDeletion =
        session.state === 'destroyed' && session.sandboxDeletionVerifiedAt !== null
      if (!isProvisioning && !isVerifiedDeletion) {
        context.addIssue({
          code: 'custom',
          path: ['bindings'],
          message:
            'Zero active bindings is valid only during provisioning or after verified deletion',
        })
      }
    }

    if (session.state === 'destroyed') {
      if (session.sandboxDeletionVerifiedAt === null) {
        context.addIssue({
          code: 'custom',
          path: ['sandboxDeletionVerifiedAt'],
          message: 'Destroyed Sessions require verified provider deletion',
        })
      }
      if (activeBindings.length !== 0) {
        context.addIssue({
          code: 'custom',
          path: ['bindings'],
          message: 'Destroyed Sessions cannot retain an active binding',
        })
      }
    } else if (session.sandboxDeletionVerifiedAt !== null) {
      context.addIssue({
        code: 'custom',
        path: ['sandboxDeletionVerifiedAt'],
        message: 'Deletion verification is valid only for a destroyed Session',
      })
    }

    if (VERIFIED_STABLE_STATES.has(session.state) && session.providerVerifiedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['providerVerifiedAt'],
        message: `Stable Session state ${session.state} requires provider verification`,
      })
    }

    if (TRANSITIONAL_STATES.has(session.state) && session.currentOperationId === null) {
      context.addIssue({
        code: 'custom',
        path: ['currentOperationId'],
        message: `Session state ${session.state} requires a current Operation`,
      })
    }
    if (
      !TRANSITIONAL_STATES.has(session.state) &&
      session.state !== 'error' &&
      session.currentOperationId !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['currentOperationId'],
        message: `Stable Session state ${session.state} cannot retain a current Operation`,
      })
    }
  })

export const SandboxSchema = z
  .strictObject({
    id: SandboxIdSchema,
    projectId: ProjectIdSchema,
    providerSandboxId: ProviderSandboxIdSchema,
    provider: z.string().regex(PROVIDER_NAME_PATTERN),
    lifecycle: ProviderLifecycleObservationSchema,
    specification: RequestedEffectiveSpecSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .superRefine((sandbox, context) => {
    if (sandbox.updatedAt < sandbox.createdAt) {
      context.addIssue({ code: 'custom', message: 'Sandbox update cannot precede creation' })
    }
    if (
      sandbox.lifecycle.observedAt < sandbox.createdAt ||
      sandbox.lifecycle.observedAt > sandbox.updatedAt
    ) {
      context.addIssue({
        code: 'custom',
        path: ['lifecycle', 'observedAt'],
        message: 'Provider observation must fall within the Sandbox record lifetime',
      })
    }
    if (
      sandbox.specification.effectiveObservedAt !== null &&
      (sandbox.specification.effectiveObservedAt < sandbox.createdAt ||
        sandbox.specification.effectiveObservedAt > sandbox.updatedAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['specification', 'effectiveObservedAt'],
        message: 'Effective specification observation must fall within the Sandbox lifetime',
      })
    }
  })

export type Project = z.infer<typeof ProjectSchema>
export type Session = z.infer<typeof SessionSchema>
export type Sandbox = z.infer<typeof SandboxSchema>
export type SandboxRole = z.infer<typeof SandboxRoleSchema>
export type SessionSandboxBinding = z.infer<typeof SessionSandboxBindingSchema>

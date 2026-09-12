import type { SandboxBinding, Session as HostedSession } from '../../api/generated/client.js'
import {
  ProviderLifecycleObservationSchema,
  type ProviderLifecycleState,
} from '../../domain/lifecycle.js'
import { UtcTimestampSchema } from '../../domain/timestamps.js'
import { OcboxError } from '../../errors/index.js'
import { newRequestId } from '../../auth/errors.js'

function orderedBindings(session: HostedSession): SandboxBinding[] {
  return [...session.sandboxes].sort((a, b) => a.ordinal - b.ordinal)
}

/**
 * Resolves the single active primary binding. Ordering is by ascending
 * ordinal; at most one active primary is valid in v0.1. Multiple active
 * bindings are a typed incompatible-server error, never silently ignored.
 * Provider IDs are never trusted for authorization: callers must verify the
 * owned parent (project/session) before invoking this helper.
 */
export function resolvePrimaryBinding(session: HostedSession): SandboxBinding | null {
  const ordered = orderedBindings(session)
  const active = ordered.filter((binding) => binding.active)
  if (active.length > 1) {
    throw new OcboxError({
      code: 'INVALID_STATE',
      message: 'The hosted session reports multiple active sandbox bindings',
      providerCode: 'MULTIPLE_ACTIVE_PRIMARY_BINDINGS',
      requestId: newRequestId(),
      details: { session: session.id.slice(0, 8) },
    })
  }
  const primary: SandboxBinding | null = active.length === 1 ? (active[0] as SandboxBinding) : null
  if (primary !== null && primary.role !== 'primary') {
    throw new OcboxError({
      code: 'INVALID_STATE',
      message: 'The hosted session reports a non-primary active binding',
      providerCode: 'NON_PRIMARY_ACTIVE_BINDING',
      requestId: newRequestId(),
    })
  }
  if (primary === null) return null
  const resolved: SandboxBinding = primary
  if (session.primarySandboxId !== null && session.primarySandboxId !== resolved.sandboxId) {
    throw new OcboxError({
      code: 'INVALID_STATE',
      message: 'The hosted session primary pointer disagrees with its bindings',
      providerCode: 'PRIMARY_BINDING_MISMATCH',
      requestId: newRequestId(),
    })
  }
  return resolved
}

/** Verifies the hosted session belongs to the configured hosted project. */
export function assertOwnedSession(session: HostedSession, hostedProjectId: string): void {
  if (session.projectId !== hostedProjectId) {
    throw new OcboxError({
      code: 'PROJECT_NOT_FOUND',
      message: 'The requested hosted resource was not found',
      providerCode: 'SESSION_PROJECT_MISMATCH',
      requestId: newRequestId(),
    })
  }
}

function lifecycleStateOf(bindingState: SandboxBinding['state']): ProviderLifecycleState {
  return bindingState === 'running' ? 'running' : 'stopped'
}

export function lifecycleObservationFor(
  binding: SandboxBinding,
  observedAt: string,
): {
  normalizedState: ProviderLifecycleState
  rawState: string
  observedAt: string
} {
  const parsed = UtcTimestampSchema.parse(observedAt)
  const observation = ProviderLifecycleObservationSchema.parse({
    desiredState: null,
    lifecycleTimestamps: {
      creationStartedAt: null,
      runningAt: null,
      pauseStartedAt: null,
      pausedAt: null,
      stopStartedAt: null,
      stoppedAt: null,
      deletionStartedAt: null,
      deletedAt: null,
      errorAt: null,
      lastTransitionAt: null,
    },
    normalizedState: lifecycleStateOf(binding.state),
    observedAt: parsed,
    rawState: binding.state,
    reason: null,
  })
  return {
    normalizedState: observation.normalizedState,
    observedAt: observation.observedAt,
    rawState: observation.rawState,
  }
}

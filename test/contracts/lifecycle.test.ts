import { describe, expect, it } from 'vitest'
import {
  LIFECYCLE_RETENTION,
  PROVIDER_LIFECYCLE_STATES,
  SESSION_RECOVERY_TRANSITIONS,
  SESSION_STATES,
  SESSION_TRANSITIONS,
  assertSessionTransition,
  canTransitionSessionState,
  isSessionRecoveryTransition,
  observeProviderLifecycle,
  type ProviderLifecycleObservation,
  type SessionState,
} from '../../src/contracts.js'
import { ids, sandbox, timestamps } from './test-data.js'

const stableProviderStates = {
  active: 'running',
  paused: 'paused',
  stopped: 'stopped',
  destroyed: 'deleted',
} as const

type StableSessionState = keyof typeof stableProviderStates

function observationFor(target: StableSessionState): ProviderLifecycleObservation
function observationFor(target: SessionState): ProviderLifecycleObservation | undefined
function observationFor(target: SessionState): ProviderLifecycleObservation | undefined {
  if (!['active', 'paused', 'stopped', 'destroyed'].includes(target)) return undefined
  const stableTarget = target as StableSessionState
  const normalizedState = stableProviderStates[stableTarget]
  return {
    ...sandbox.lifecycle,
    normalizedState,
    rawState: normalizedState.toUpperCase(),
    lifecycleTimestamps: {
      ...sandbox.lifecycle.lifecycleTimestamps,
      ...(stableTarget === 'destroyed'
        ? { deletionStartedAt: timestamps.created, deletedAt: timestamps.observed }
        : {}),
    },
  }
}

describe('Session lifecycle', () => {
  it('contains exactly the locked states', () => {
    expect(SESSION_STATES).toEqual([
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
    ])
  })

  it('covers every legal and illegal pair exhaustively', () => {
    for (const from of SESSION_STATES) {
      for (const to of SESSION_STATES) {
        const expected = (SESSION_TRANSITIONS[from] as readonly string[]).includes(to)
        expect(canTransitionSessionState(from, to), `${from} -> ${to}`).toBe(expected)
        const providerObservation = observationFor(to)

        const invoke = (): void =>
          assertSessionTransition(from, to, {
            operationId: ids.operation,
            ...(providerObservation === undefined
              ? {}
              : { transitionStartedAt: timestamps.created, providerObservation }),
          })
        if (expected) expect(invoke, `${from} -> ${to}`).not.toThrow()
        else expect(invoke, `${from} -> ${to}`).toThrow(/Illegal Session transition/)
      }
    }
  })

  it('requires an Operation for transitions and provider evidence for success', () => {
    expect(() => assertSessionTransition('active', 'pausing', {})).toThrow(/Operation ID/)
    expect(() =>
      assertSessionTransition('pausing', 'paused', { operationId: ids.operation }),
    ).toThrow(/provider observation/)
    expect(() =>
      assertSessionTransition('pausing', 'paused', {
        operationId: ids.operation,
        transitionStartedAt: timestamps.created,
        providerObservation: observationFor('paused'),
      }),
    ).not.toThrow()
  })

  it('guards rollback and reconciliation with an aligned provider observation', () => {
    expect(SESSION_RECOVERY_TRANSITIONS).toEqual({
      pausing: ['active'],
      stopping: ['active', 'paused'],
      resuming: ['paused', 'stopped'],
      error: ['active', 'paused', 'stopped', 'destroyed'],
    })

    for (const from of SESSION_STATES) {
      for (const to of SESSION_STATES) {
        const expected = Object.entries(SESSION_RECOVERY_TRANSITIONS).some(
          ([candidateFrom, targets]) =>
            candidateFrom === from && (targets as readonly SessionState[]).includes(to),
        )
        expect(isSessionRecoveryTransition(from, to), `${from} -> ${to}`).toBe(expected)
      }
    }

    expect(() =>
      assertSessionTransition('pausing', 'active', {
        operationId: ids.operation,
        transitionStartedAt: timestamps.created,
        providerObservation: observationFor('paused'),
      }),
    ).toThrow(/requires provider state running/)
    expect(() =>
      assertSessionTransition('pausing', 'active', {
        operationId: ids.operation,
        transitionStartedAt: timestamps.created,
        providerObservation: observationFor('active'),
      }),
    ).not.toThrow()
    expect(() =>
      assertSessionTransition('error', 'stopped', {
        transitionStartedAt: timestamps.created,
        providerObservation: observationFor('stopped'),
      }),
    ).not.toThrow()
    expect(() =>
      assertSessionTransition('error', 'destroyed', {
        transitionStartedAt: timestamps.created,
        providerObservation: observationFor('active'),
      }),
    ).toThrow(/requires provider state deleted/)
    expect(() =>
      assertSessionTransition('error', 'destroyed', {
        transitionStartedAt: timestamps.created,
        providerObservation: observationFor('destroyed'),
      }),
    ).not.toThrow()
  })

  it('rejects structurally incomplete provider evidence at the transition boundary', () => {
    expect(() =>
      assertSessionTransition('error', 'active', {
        transitionStartedAt: timestamps.created,
        providerObservation: {
          normalizedState: 'running',
          rawState: 'RUNNING',
        } as ProviderLifecycleObservation,
      }),
    ).toThrow()
  })

  it.each([
    ['rollback', 'pausing', 'active'],
    ['error recovery', 'error', 'stopped'],
    ['deletion recovery', 'error', 'destroyed'],
  ] as const)('rejects a stale %s observation', (_case, from, to) => {
    expect(() =>
      assertSessionTransition(from, to, {
        ...(from === 'pausing' ? { operationId: ids.operation } : {}),
        transitionStartedAt: timestamps.completed,
        providerObservation: observationFor(to),
      }),
    ).toThrow(/older than the transition start/)
  })

  it('requires explicit deletion evidence for destroyed', () => {
    const deleted = observationFor('destroyed')
    expect(() =>
      assertSessionTransition('error', 'destroyed', {
        transitionStartedAt: timestamps.created,
        providerObservation: {
          ...deleted,
          lifecycleTimestamps: { ...deleted.lifecycleTimestamps, deletedAt: null },
        },
      }),
    ).toThrow(/verified provider deletion/)
  })

  it('locks the product retention semantics', () => {
    expect(LIFECYCLE_RETENTION.pause).toEqual({
      processes: 'preserved',
      memory: 'preserved',
      filesystem: 'preserved',
    })
    expect(LIFECYCLE_RETENTION.stop).toEqual({
      processes: 'discarded',
      memory: 'discarded',
      filesystem: 'preserved',
    })
    expect(LIFECYCLE_RETENTION.destroy).toEqual({
      processes: 'discarded',
      memory: 'discarded',
      filesystem: 'discarded',
    })
  })
})

describe('provider lifecycle normalization', () => {
  it('keeps the provider lifecycle distinct and complete', () => {
    expect(PROVIDER_LIFECYCLE_STATES).toEqual([
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
    ])
  })

  it('normalizes unknown states without losing the raw provider value', () => {
    const observation = observeProviderLifecycle({
      rawState: 'HIBERNATING_PROVIDER_V2',
      mapping: { RUNNING: 'running' },
      desiredState: 'paused',
      reason: 'provider reported a new state',
      observedAt: timestamps.observed,
      lifecycleTimestamps: {
        creationStartedAt: timestamps.created,
        runningAt: null,
        pauseStartedAt: null,
        pausedAt: null,
        stopStartedAt: null,
        stoppedAt: null,
        deletionStartedAt: null,
        deletedAt: null,
        errorAt: null,
        lastTransitionAt: timestamps.observed,
      },
    })

    expect(observation.normalizedState).toBe('unknown')
    expect(observation.rawState).toBe('HIBERNATING_PROVIDER_V2')
    expect(observation.desiredState).toBe('paused')
  })

  it('rejects blank raw states and impossible provider timestamp ordering', () => {
    const common = {
      mapping: {},
      desiredState: null,
      reason: null,
      observedAt: timestamps.observed,
      lifecycleTimestamps: {
        creationStartedAt: timestamps.created,
        runningAt: timestamps.observed,
        pauseStartedAt: null,
        pausedAt: null,
        stopStartedAt: null,
        stoppedAt: null,
        deletionStartedAt: null,
        deletedAt: null,
        errorAt: null,
        lastTransitionAt: timestamps.observed,
      },
    } as const

    expect(() => observeProviderLifecycle({ ...common, rawState: '   ' })).toThrow()
    expect(() =>
      observeProviderLifecycle({
        ...common,
        rawState: 'RUNNING',
        lifecycleTimestamps: {
          ...common.lifecycleTimestamps,
          creationStartedAt: timestamps.completed,
        },
      }),
    ).toThrow()
  })
})

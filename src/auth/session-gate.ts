import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  AtomicStoreCancelledError,
  AtomicStoreConflictError,
} from '../lifecycle/atomic-json-store.js'
import { ExclusiveFileLock } from '../state/exclusive-file-lock.js'
import { OcboxError } from '../errors/index.js'
import { newRequestId } from './errors.js'

/**
 * Bounded coordinator for authenticated credential reads and every session
 * mutation. It wraps the shared T3 exclusive-file lock so login, status,
 * logout, and token refresh cannot interleave different state generations across CLI processes.
 * It is always the outermost lock: the metadata and credential stores keep
 * their own locks and are only ever acquired inside this one, so no lock cycle
 * exists. Login releases the gate while the user is in the browser and
 * acquires it only to snapshot prior state and commit (or roll back).
 */
export const AUTH_STATE_LOCK_FILENAME = 'auth.state.lock'

/** Two acquisition attempts give a briefly held lock a second chance. */
const LOCK_ATTEMPT_LIMIT = 2
const LOCK_RETRY_DELAY_MILLISECONDS = 100

export type SessionGate = <Result>(
  action: () => Promise<Result>,
  signal?: AbortSignal | undefined,
) => Promise<Result>

export interface SessionGateOptions {
  readonly lockWaitMilliseconds?: number
}

export function createSessionGate(
  stateDirectory: string,
  options: SessionGateOptions = {},
): SessionGate {
  const lock = new ExclusiveFileLock({
    createCancelledError: () => new AtomicStoreCancelledError(),
    createTimeoutError: () => new AtomicStoreConflictError(),
    ...(options.lockWaitMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.lockWaitMilliseconds }),
  })
  const lockPath = join(stateDirectory, AUTH_STATE_LOCK_FILENAME)
  return async (action, signal) => {
    for (let attempt = 1; ; attempt += 1) {
      let actionStarted = false
      try {
        return await lock.withLock(lockPath, signal, async () => {
          actionStarted = true
          return action()
        })
      } catch (error) {
        if (error instanceof AtomicStoreCancelledError) {
          throw new OcboxError({
            code: 'OPERATION_CANCELLED',
            message: 'The wait for another CLI process updating authentication state was cancelled',
            requestId: newRequestId(),
          })
        }
        if (error instanceof AtomicStoreConflictError) {
          // A conflict raised by the action itself must not be retried: the lock
          // was acquired and the action may already have changed state.
          if (!actionStarted && attempt < LOCK_ATTEMPT_LIMIT) {
            try {
              await delay(LOCK_RETRY_DELAY_MILLISECONDS, undefined, { signal })
            } catch {
              throw new OcboxError({
                code: 'OPERATION_CANCELLED',
                message:
                  'The wait for another CLI process updating authentication state was cancelled',
                requestId: newRequestId(),
              })
            }
            continue
          }
          throw new OcboxError({
            code: 'OPERATION_CONFLICT',
            message: 'Another CLI process is updating authentication state; try again shortly',
            details: {
              nextStep:
                'Wait a moment for the other CLI process to finish, then rerun the command.',
            },
            requestId: newRequestId(),
          })
        }
        throw error
      }
    }
  }
}

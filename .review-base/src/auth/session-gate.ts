import { join } from 'node:path'
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
  return async (action, signal) => {
    try {
      return await lock.withLock(join(stateDirectory, AUTH_STATE_LOCK_FILENAME), signal, action)
    } catch (error) {
      if (error instanceof AtomicStoreCancelledError) {
        throw new OcboxError({
          code: 'OPERATION_CANCELLED',
          message: 'The wait for another CLI process updating authentication state was cancelled',
          requestId: newRequestId(),
        })
      }
      if (error instanceof AtomicStoreConflictError) {
        throw new OcboxError({
          code: 'OPERATION_CONFLICT',
          message: 'Another CLI process is updating authentication state; try again shortly',
          requestId: newRequestId(),
        })
      }
      throw error
    }
  }
}

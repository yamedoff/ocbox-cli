import { join } from 'node:path'
import {
  AtomicStoreCancelledError,
  AtomicStoreConflictError,
} from '../lifecycle/atomic-json-store.js'
import { ExclusiveFileLock } from '../state/exclusive-file-lock.js'
import { OcboxError } from '../errors/index.js'
import { newRequestId } from './errors.js'

/**
 * Bounded coordinator for the login/status/logout critical sections. It wraps
 * the shared T3 exclusive-file lock so two CLI processes never interleave a
 * state snapshot with another actor's credential/metadata commit. It is always
 * the outermost lock: the metadata and credential stores keep their own locks
 * and are only ever acquired inside this one, so no lock cycle exists. Login
 * deliberately releases the gate while the user is in the browser and
 * re-acquires it only to snapshot prior state and to commit (or roll back).
 */
export type SessionGate = <Result>(action: () => Promise<Result>) => Promise<Result>

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
  return async (action) => {
    try {
      return await lock.withLock(join(stateDirectory, 'auth.session.lock'), undefined, action)
    } catch (error) {
      if (error instanceof AtomicStoreConflictError || error instanceof AtomicStoreCancelledError) {
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

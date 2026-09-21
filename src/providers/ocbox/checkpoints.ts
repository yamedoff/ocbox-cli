import { join } from 'node:path'
import { z } from 'zod'
import { AtomicJsonStore } from '../../lifecycle/atomic-json-store.js'
import type { OperationCheckpoint, OperationCheckpointStore } from './operations.js'
import { HostedOperationSchema, HostedOperationStateSchema } from './wire.js'

/**
 * Durable operation-checkpoint repository. A restarted CLI reloads the last
 * observed Operation state from `<stateDirectory>/ocbox-operation-checkpoints.json`
 * and, when the state is terminal, returns (or rejects) it without any network
 * call. The write goes through the same schema-validating atomic JSON store
 * used by lifecycle state, so a crash mid-write never yields a partial file.
 */
const OperationCheckpointSchema = z.strictObject({
  attempt: z.number().int().min(0),
  operation: HostedOperationSchema.nullable(),
  operationId: z.string().min(1).max(256),
  progress: z.number().int().min(0).max(100),
  requestId: z.string().min(1).max(128).nullable(),
  state: HostedOperationStateSchema.nullable(),
})

const OperationCheckpointFileSchema = z.strictObject({
  checkpoints: z.record(z.string().min(1).max(256), OperationCheckpointSchema),
  version: z.literal(1),
})

type OperationCheckpointFile = z.infer<typeof OperationCheckpointFileSchema>

export class FileOperationCheckpointStore implements OperationCheckpointStore {
  readonly #store: AtomicJsonStore<OperationCheckpointFile>

  constructor(stateDirectory: string) {
    this.#store = new AtomicJsonStore(
      join(stateDirectory, 'ocbox-operation-checkpoints.json'),
      OperationCheckpointFileSchema,
    )
  }

  async load(operationId: string): Promise<OperationCheckpoint | null> {
    const file = await this.#store.load()
    if (file === null) return null
    // The persisted shape is validated against the pinned wire schema; the
    // generated `SafeError` allows an optional `retryAfterSeconds` without an
    // explicit `undefined`, so bridge the equivalent representations.
    const checkpoint = file.checkpoints[operationId] as unknown as OperationCheckpoint | undefined
    return checkpoint ?? null
  }

  async save(checkpoint: OperationCheckpoint): Promise<void> {
    await this.#store.update(
      () => ({ checkpoints: {}, version: 1 }),
      (current) => ({
        checkpoints: { ...current.checkpoints, [checkpoint.operationId]: checkpoint },
        version: 1,
      }),
    )
  }
}

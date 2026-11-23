import { join } from 'node:path'
import type { ProjectId } from '../contracts.js'
import { AtomicJsonStore } from './atomic-json-store.js'
import {
  emptyLifecycleProjectState,
  LifecycleProjectStateSchema,
  type LifecycleProjectState,
} from './schema.js'

/** Project-scoped persisted Session/Sandbox/Operation repository. */
export class LifecycleStore {
  readonly #projectId: ProjectId
  readonly #store: AtomicJsonStore<LifecycleProjectState>

  constructor(stateDirectory: string, projectId: ProjectId) {
    this.#projectId = projectId
    this.#store = new AtomicJsonStore(
      join(stateDirectory, 'lifecycle', `${projectId}.json`),
      LifecycleProjectStateSchema,
    )
  }

  async load(): Promise<LifecycleProjectState> {
    return (await this.#store.load()) ?? emptyLifecycleProjectState(this.#projectId)
  }

  async update(
    mutate: (current: LifecycleProjectState) => LifecycleProjectState,
    signal?: AbortSignal,
  ) {
    return this.#store.update(() => emptyLifecycleProjectState(this.#projectId), mutate, signal)
  }
}

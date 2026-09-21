import { z } from 'zod'
import {
  OperationIdSchema,
  OperationSchema,
  ProjectIdSchema,
  SandboxIdSchema,
  SandboxSchema,
  SandboxSpecSchema,
  SessionIdSchema,
  SessionSchema,
} from '../contracts.js'

/** Durable CLI-owned lifecycle state. Provider resources are stored separately. */
export const LifecycleProjectStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: ProjectIdSchema,
  activeSessionId: SessionIdSchema.nullable(),
  sessions: z.record(SessionIdSchema, SessionSchema),
  sandboxes: z.record(SandboxIdSchema, SandboxSchema),
  operations: z.record(OperationIdSchema, OperationSchema),
  operationAttempts: z.record(OperationIdSchema, z.number().int().positive().safe()),
  pendingCreateSpecs: z.record(OperationIdSchema, SandboxSpecSchema),
})

export type LifecycleProjectState = z.infer<typeof LifecycleProjectStateSchema>

export function emptyLifecycleProjectState(
  projectId: LifecycleProjectState['projectId'],
): LifecycleProjectState {
  return {
    schemaVersion: 1,
    projectId,
    activeSessionId: null,
    sessions: {},
    sandboxes: {},
    operations: {},
    operationAttempts: {},
    pendingCreateSpecs: {},
  }
}

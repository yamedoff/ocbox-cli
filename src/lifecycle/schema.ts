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

/** Non-secret hosted identity mapping, stored under the lifecycle project lock. */
export const HostedSandboxMappingSchema = z.strictObject({
  localId: SandboxIdSchema,
  localSessionId: SessionIdSchema,
  localProjectId: ProjectIdSchema,
  hostedSessionId: z.string().min(1),
  hostedSandboxId: z.string().min(1),
  lastExecutionId: z.string().min(1).optional(),
  spec: SandboxSpecSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  stale: z.boolean().default(false),
  deleted: z.boolean().default(false),
})
export type HostedSandboxMapping = z.infer<typeof HostedSandboxMappingSchema>

/** Durable CLI-owned lifecycle state. Provider resources are stored separately. */
export const LifecycleProjectStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: ProjectIdSchema,
  activeSessionId: SessionIdSchema.nullable(),
  sessions: z.record(SessionIdSchema, SessionSchema),
  sandboxes: z.record(SandboxIdSchema, SandboxSchema),
  operations: z.record(OperationIdSchema, OperationSchema),
  operationAttempts: z.record(OperationIdSchema, z.number().int().positive().safe()),
  hostedMappings: z
    .record(z.string(), z.record(SandboxIdSchema, HostedSandboxMappingSchema))
    .default({}),
  lastFakeExecutions: z.record(SandboxIdSchema, z.string().min(1)).default({}),
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
    hostedMappings: {},
    lastFakeExecutions: {},
  }
}

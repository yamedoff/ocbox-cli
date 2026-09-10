import { z } from 'zod'
import {
  IdempotencyKeySchema,
  OperationIdSchema,
  ProviderSandboxIdSchema,
  SandboxSchema,
  SessionIdSchema,
} from '../../contracts.js'

export const FakeProviderResourceSchema = z.strictObject({
  sandbox: SandboxSchema,
  sessionId: SessionIdSchema,
  createOperationId: OperationIdSchema,
  lastOperationId: OperationIdSchema,
})

export const FakeProviderStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  resources: z.record(ProviderSandboxIdSchema, FakeProviderResourceSchema),
  idempotency: z.record(IdempotencyKeySchema, ProviderSandboxIdSchema),
  consumedLostResponses: z.record(z.string(), z.literal(true)),
})

export type FakeProviderResource = z.infer<typeof FakeProviderResourceSchema>
export type FakeProviderState = z.infer<typeof FakeProviderStateSchema>

export const EMPTY_FAKE_PROVIDER_STATE: FakeProviderState = {
  schemaVersion: 1,
  resources: {},
  idempotency: {},
  consumedLostResponses: {},
}

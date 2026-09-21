import { z } from 'zod'

/**
 * Internal identifiers are opaque UUIDs or ULIDs. The runtime shape remains
 * deliberately independent of storage technology, while the Zod brands make
 * identifiers nominally distinct to TypeScript callers.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

const InternalIdSchema = z
  .string()
  .trim()
  .refine((value) => UUID_PATTERN.test(value) || ULID_PATTERN.test(value), {
    message: 'Expected an opaque UUID or ULID identifier',
  })

export const ProjectIdSchema = InternalIdSchema.brand<'ProjectId'>()
export const SessionIdSchema = InternalIdSchema.brand<'SessionId'>()
export const SandboxIdSchema = InternalIdSchema.brand<'SandboxId'>()
export const BindingIdSchema = InternalIdSchema.brand<'BindingId'>()
export const OperationIdSchema = InternalIdSchema.brand<'OperationId'>()
export const ExecutionIdSchema = InternalIdSchema.brand<'ExecutionId'>()
export const RequestIdSchema = InternalIdSchema.brand<'RequestId'>()

/**
 * Provider identifiers are opaque to OpenCloudBox and may not use UUID/ULID
 * syntax. Control characters and whitespace are rejected so they are safe to
 * carry as metadata, but the value is never treated as an OpenCloudBox ID.
 */
export const ProviderSandboxIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x21-\x7e]+$/, 'Provider sandbox IDs must be printable opaque values')
  .brand<'ProviderSandboxId'>()

export const IdempotencyKeySchema = z
  .string()
  .min(16)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency keys must use a transport-safe alphabet')
  .brand<'IdempotencyKey'>()

export type ProjectId = z.infer<typeof ProjectIdSchema>
export type SessionId = z.infer<typeof SessionIdSchema>
export type SandboxId = z.infer<typeof SandboxIdSchema>
export type ProviderSandboxId = z.infer<typeof ProviderSandboxIdSchema>
export type BindingId = z.infer<typeof BindingIdSchema>
export type OperationId = z.infer<typeof OperationIdSchema>
export type ExecutionId = z.infer<typeof ExecutionIdSchema>
export type RequestId = z.infer<typeof RequestIdSchema>
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>

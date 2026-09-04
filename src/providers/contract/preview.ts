import { z } from 'zod'
import { SandboxIdSchema } from '../../domain/ids.js'
import { OperationSchema, type Operation, type OperationContext } from '../../domain/operation.js'
import { UtcTimestampSchema } from '../../domain/timestamps.js'

export const PreviewProtocolSchema = z.enum(['http', 'https', 'ws', 'wss'])

export const CreatePreviewRequestSchema = z.strictObject({
  sandboxId: SandboxIdSchema,
  port: z.number().int().min(1).max(65_535),
  protocol: PreviewProtocolSchema,
  expiresInMilliseconds: z.number().int().positive().safe(),
})

export const PreviewSchema = z
  .strictObject({
    operation: OperationSchema,
    sandboxId: SandboxIdSchema,
    port: z.number().int().min(1).max(65_535),
    protocol: PreviewProtocolSchema,
    url: z.string().url().max(2_048),
    authenticated: z.literal(true),
    expiresAt: UtcTimestampSchema,
  })
  .superRefine((preview, context) => {
    if (preview.operation.status !== 'succeeded' || preview.operation.action !== 'preview_create') {
      context.addIssue({
        code: 'custom',
        path: ['operation'],
        message: 'Preview results require a successful preview_create Operation',
      })
    }
    if (preview.operation.sandboxId !== preview.sandboxId) {
      context.addIssue({
        code: 'custom',
        path: ['operation', 'sandboxId'],
        message: 'Preview Operation must identify the target Sandbox',
      })
    }
    const url = new URL(preview.url)
    if (url.username.length !== 0 || url.password.length !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'Preview URL cannot embed credentials',
      })
    }
    if (url.protocol.slice(0, -1) !== preview.protocol) {
      context.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'Preview URL protocol must match',
      })
    }
  })

export const RevokePreviewRequestSchema = z.strictObject({
  sandboxId: SandboxIdSchema,
  url: z.string().url().max(2_048),
})

export type PreviewProtocol = z.infer<typeof PreviewProtocolSchema>
export type CreatePreviewRequest = z.infer<typeof CreatePreviewRequestSchema>
export type Preview = z.infer<typeof PreviewSchema>
export type RevokePreviewRequest = z.infer<typeof RevokePreviewRequestSchema>

export interface ProviderPreviews {
  create(context: OperationContext, request: CreatePreviewRequest): Promise<Preview>
  revoke(context: OperationContext, request: RevokePreviewRequest): Promise<Operation>
}

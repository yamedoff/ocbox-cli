import { z } from 'zod'
import { SandboxIdSchema } from '../../domain/ids.js'
import { OperationSchema, type OperationContext } from '../../domain/operation.js'
import { SandboxSourceSpecSchema } from '../../domain/spec.js'

export const ApplySourceRequestSchema = z.strictObject({
  sandboxId: SandboxIdSchema,
  source: SandboxSourceSpecSchema,
})

export const ApplySourceResultSchema = z
  .strictObject({
    operation: OperationSchema,
    sandboxId: SandboxIdSchema,
    contentDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((result, context) => {
    if (result.operation.status !== 'succeeded' || result.operation.action !== 'source_apply') {
      context.addIssue({
        code: 'custom',
        path: ['operation'],
        message: 'Apply-source results require a successful source_apply Operation',
      })
    }
    if (result.operation.sandboxId !== result.sandboxId) {
      context.addIssue({
        code: 'custom',
        path: ['operation', 'sandboxId'],
        message: 'Apply-source Operation must identify the target Sandbox',
      })
    }
  })

export type ApplySourceRequest = z.infer<typeof ApplySourceRequestSchema>
export type ApplySourceResult = z.infer<typeof ApplySourceResultSchema>

export interface ProviderSource {
  apply(context: OperationContext, request: ApplySourceRequest): Promise<ApplySourceResult>
}

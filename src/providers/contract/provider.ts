import { z } from 'zod'
import {
  ExecutionIdSchema,
  ProjectIdSchema,
  SandboxIdSchema,
  SessionIdSchema,
} from '../../domain/ids.js'
import type { ExecHandle, ExecRequest } from '../../domain/execution.js'
import {
  CreateAdoptionPolicySchema,
  OperationSchema,
  type Operation,
  type OperationContext,
  type RequestContext,
} from '../../domain/operation.js'
import { SandboxSchema, type Sandbox } from '../../domain/entities.js'
import { SandboxSpecSchema } from '../../domain/spec.js'
import type { ProviderCapabilities } from './capabilities.js'
import type { ProviderFiles } from './files.js'
import type { ProviderPreviews } from './preview.js'
import type { ProviderSource } from './source.js'

export const CreateSandboxRequestSchema = z
  .strictObject({
    projectId: ProjectIdSchema,
    sessionId: SessionIdSchema,
    specification: SandboxSpecSchema,
    adoption: CreateAdoptionPolicySchema,
  })
  .superRefine((request, context) => {
    if (request.adoption.metadata.sessionId !== request.sessionId) {
      context.addIssue({
        code: 'custom',
        path: ['adoption', 'metadata', 'sessionId'],
        message: 'Create adoption metadata must identify the requested Session',
      })
    }
  })

export const GetSandboxRequestSchema = z.strictObject({
  sandboxId: SandboxIdSchema,
})

export const ListSandboxesRequestSchema = z.strictObject({
  projectId: ProjectIdSchema.nullable(),
  sessionId: SessionIdSchema.nullable(),
})

export const LifecycleMutationRequestSchema = z.strictObject({
  sandboxId: SandboxIdSchema,
})

export const SandboxMutationResultSchema = z
  .strictObject({
    operation: OperationSchema,
    sandbox: SandboxSchema,
  })
  .superRefine((result, context) => {
    const expectedProviderState = (() => {
      switch (result.operation.action) {
        case 'create':
        case 'start':
        case 'resume':
          return 'running'
        case 'pause':
          return 'paused'
        case 'stop':
          return 'stopped'
        case 'destroy':
          return 'deleted'
        default:
          return undefined
      }
    })()

    if (expectedProviderState === undefined || result.operation.status !== 'succeeded') {
      context.addIssue({
        code: 'custom',
        path: ['operation'],
        message: 'Sandbox mutation results require a successful lifecycle Operation',
      })
      return
    }
    if (result.operation.sandboxId !== result.sandbox.id) {
      context.addIssue({
        code: 'custom',
        path: ['operation', 'sandboxId'],
        message: 'Sandbox mutation Operation must identify the returned Sandbox',
      })
    }
    if (
      result.operation.providerVerifiedAt !== result.sandbox.lifecycle.observedAt ||
      result.sandbox.lifecycle.normalizedState !== expectedProviderState
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sandbox', 'lifecycle'],
        message: `Sandbox mutation ${result.operation.action} requires a matching fresh provider observation`,
      })
    }
  })

export const CancelExecutionRequestSchema = z.strictObject({
  executionId: ExecutionIdSchema,
})

export type CreateSandboxRequest = z.infer<typeof CreateSandboxRequestSchema>
export type GetSandboxRequest = z.infer<typeof GetSandboxRequestSchema>
export type ListSandboxesRequest = z.infer<typeof ListSandboxesRequestSchema>
export type LifecycleMutationRequest = z.infer<typeof LifecycleMutationRequestSchema>
export type SandboxMutationResult = z.infer<typeof SandboxMutationResultSchema>
export type CancelExecutionRequest = z.infer<typeof CancelExecutionRequestSchema>

export interface ProviderExecution {
  execute(context: OperationContext, request: ExecRequest): Promise<ExecHandle>
  cancel(context: OperationContext, request: CancelExecutionRequest): Promise<Operation>
}

/**
 * Provider-neutral port. Provider adapters translate their SDK objects into
 * these contracts; no SDK type or import may cross this boundary.
 */
export interface SandboxProvider {
  readonly name: string
  readonly exec: ProviderExecution
  readonly files: ProviderFiles
  readonly source: ProviderSource
  readonly previews: ProviderPreviews

  capabilities(context: RequestContext): Promise<ProviderCapabilities>
  create(context: OperationContext, request: CreateSandboxRequest): Promise<SandboxMutationResult>
  get(context: RequestContext, request: GetSandboxRequest): Promise<Sandbox | null>
  list(context: RequestContext, request: ListSandboxesRequest): Promise<readonly Sandbox[]>
  start(
    context: OperationContext,
    request: LifecycleMutationRequest,
  ): Promise<SandboxMutationResult>
  pause(
    context: OperationContext,
    request: LifecycleMutationRequest,
  ): Promise<SandboxMutationResult>
  resume(
    context: OperationContext,
    request: LifecycleMutationRequest,
  ): Promise<SandboxMutationResult>
  stop(context: OperationContext, request: LifecycleMutationRequest): Promise<SandboxMutationResult>
  destroy(
    context: OperationContext,
    request: LifecycleMutationRequest,
  ): Promise<SandboxMutationResult>
}

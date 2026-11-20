import { z } from 'zod'
import type { OcboxApiClient } from '../api/client/index.js'
import { OcboxError } from '../errors/index.js'
import { parseHostedResponse } from './response.js'

const safeError = z.strictObject({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(1024),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  reason: z
    .enum([
      'provider_region_unavailable',
      'provider_toolbox_unreachable',
      'provider_timeout',
      'provider_refused',
      'provider_error',
      'user_active_limit',
      'global_capacity',
      'admission_closed',
      'budget_exhausted',
      'spec_not_allowed',
      'admission_unavailable',
      'workspace_busy',
      'source_apply_revoked',
    ])
    .optional(),
})
export const ExecutionSchema = z.strictObject({
  id: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  sessionId: z.string().min(1),
  sandboxId: z.string().min(1).nullable(),
  state: z.enum(['pending', 'running', 'completed', 'cancelled', 'failed']),
  command: z.string().min(1),
  exitCode: z.number().int().nullable(),
  failureKind: z.enum(['command', 'infrastructure']).nullable(),
  failure: safeError.nullable(),
  truncated: z.boolean(),
  outputBytes: z.number().int().nonnegative(),
  outputLimitBytes: z.number().int().positive(),
})
const encoding = z.strictObject({
  stdout: z.enum(['utf-8', 'utf-8-lossy']),
  stderr: z.enum(['utf-8', 'utf-8-lossy']),
})
const commandResult = z.strictObject({
  kind: z.literal('command'),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  outputBytes: z.number().int().nonnegative(),
  outputLimitBytes: z.number().int().positive(),
  encoding,
})
const infrastructureResult = z.strictObject({
  kind: z.literal('infrastructure'),
  error: safeError,
})
const cancelledResult = z.strictObject({ kind: z.literal('cancelled') })
export const ExecutionResultSchema = z.discriminatedUnion('kind', [
  commandResult,
  infrastructureResult,
  cancelledResult,
])
export type ExecutionRecord = z.infer<typeof ExecutionSchema>
export type ExecutionResultRecord = z.infer<typeof ExecutionResultSchema>

export interface ExecutionView {
  readonly execution: ExecutionRecord
  readonly result?: ExecutionResultRecord | undefined
  readonly cursor: string | null
}

function options(signal: AbortSignal | undefined) {
  return signal === undefined ? {} : { signal }
}

/** Poll one execution and, once terminal, read the result the server kept. */
export async function getExecution(
  api: OcboxApiClient,
  executionId: string,
  signal?: AbortSignal,
): Promise<ExecutionView> {
  const response = await api.generated.getExecution({
    path: { executionId },
    ...options(signal),
  })
  const { resource: execution } = parseHostedResponse(
    api,
    'execution.get',
    response,
    [200],
    ExecutionSchema,
    'execution',
  )
  if (execution.state === 'pending' || execution.state === 'running') {
    return { execution, cursor: executionId }
  }
  try {
    const resultResponse = await api.generated.getExecutionResult({
      path: { executionId },
      ...options(signal),
    })
    const { resource: result } = parseHostedResponse(
      api,
      'execution.result',
      resultResponse,
      [200],
      ExecutionResultSchema,
      'execution result',
    )
    return { execution, result, cursor: null }
  } catch (error) {
    // A terminal execution whose result is not ready yet answers 409. The
    // execution itself is still a valid read, so report it without a result.
    if (error instanceof OcboxError && error.code === 'OPERATION_CONFLICT') {
      return { execution, cursor: null }
    }
    throw error
  }
}

/** Human line: state, exit code and the stored failure reason. */
export function executionLine(view: ExecutionView): string {
  const execution = view.execution
  const exit = execution.exitCode === null ? '' : `, exit ${execution.exitCode}`
  const line = `Execution ${execution.id}: ${execution.state}${exit}`
  const reason =
    execution.failure?.reason ??
    (view.result?.kind === 'infrastructure' ? view.result.error.reason : undefined)
  return reason === undefined ? line : `${line}\nReason ${reason}.`
}

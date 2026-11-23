import { z } from 'zod'
import type { OcboxApiClient } from '../api/client/index.js'
import { newRequestId } from '../auth/errors.js'
import { OcboxError } from '../errors/index.js'
import { parseHostedResponse } from './response.js'
import { SafeErrorSchema, safeErrorReason } from './safe-error.js'

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
  failure: SafeErrorSchema.nullable(),
  hold: SafeErrorSchema.optional(),
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
  error: SafeErrorSchema,
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

export interface ExecutionLogs {
  readonly execution: ExecutionRecord
  readonly result: ExecutionResultRecord
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

/**
 * Read the stored result of a finished execution, or explain why it cannot be
 * read yet: still running, or terminal but the result route answered 409.
 */
export async function getExecutionLogs(
  api: OcboxApiClient,
  executionId: string,
  signal?: AbortSignal,
): Promise<ExecutionLogs> {
  const view = await getExecution(api, executionId, signal)
  if (view.execution.state === 'pending' || view.execution.state === 'running') {
    throw new OcboxError({
      code: 'INVALID_STATE',
      requestId: newRequestId(),
      message: `Execution ${view.execution.id} is ${view.execution.state}; its stored output is available after it finishes.`,
      details: { executionId: view.execution.id, state: view.execution.state },
    })
  }
  if (view.result === undefined) {
    throw new OcboxError({
      code: 'OPERATION_CONFLICT',
      requestId: newRequestId(),
      message: `Execution ${view.execution.id} is ${view.execution.state} but its stored result is not ready yet; retry this command.`,
      details: { executionId: view.execution.id, state: view.execution.state },
    })
  }
  return { execution: view.execution, result: view.result }
}

/** Human line: state, exit code and the stored failure reason. */
export function executionLine(view: ExecutionView): string {
  const execution = view.execution
  const exit = execution.exitCode === null ? '' : `, exit ${execution.exitCode}`
  const line = `Execution ${execution.id}: ${execution.state}${exit}`
  const reason =
    safeErrorReason(execution.failure) ??
    (view.result?.kind === 'infrastructure' ? safeErrorReason(view.result.error) : undefined)
  return reason === undefined ? line : `${line}\nReason ${reason}.`
}

import { z } from 'zod'
import { ExecutionIdSchema, OperationIdSchema, SandboxIdSchema } from './ids.js'
import { SandboxPathSchema } from './remote-path.js'
import { UtcTimestampSchema } from './timestamps.js'

export const StructuredArgvCommandSchema = z
  .strictObject({
    mode: z.literal('argv'),
    argv: z
      .array(
        z
          .string()
          .max(32_768)
          .refine((value) => !value.includes('\0')),
      )
      .min(1)
      .max(4_096)
      .readonly(),
  })
  .superRefine((command, context) => {
    if ((command.argv[0] ?? '').trim().length === 0) {
      context.addIssue({ code: 'custom', path: ['argv', 0], message: 'Executable cannot be empty' })
    }
  })

export const ShellCommandSchema = z.strictObject({
  mode: z.literal('shell'),
  shell: z
    .string()
    .min(1)
    .max(1_048_576)
    .refine((value) => value.trim().length > 0)
    .refine((value) => !value.includes('\0')),
})

export const ExecCommandSchema = z.discriminatedUnion('mode', [
  StructuredArgvCommandSchema,
  ShellCommandSchema,
])

export const ExecRequestSchema = z.strictObject({
  sandboxId: SandboxIdSchema,
  command: ExecCommandSchema,
  workingDirectory: SandboxPathSchema.nullable(),
  timeoutMilliseconds: z.number().int().positive().safe().nullable(),
})

export const ExecResultSchema = z
  .strictObject({
    exitCode: z.number().int().safe(),
    stdout: z.instanceof(Uint8Array),
    stderr: z.instanceof(Uint8Array),
    timedOut: z.boolean(),
    cancelled: z.boolean(),
    signal: z.string().min(1).max(128).nullable(),
    startedAt: UtcTimestampSchema,
    completedAt: UtcTimestampSchema,
  })
  .superRefine((result, context) => {
    if (result.completedAt < result.startedAt) {
      context.addIssue({ code: 'custom', message: 'Execution cannot complete before it starts' })
    }
    if (result.timedOut && result.cancelled) {
      context.addIssue({ code: 'custom', message: 'Execution cannot be timed out and cancelled' })
    }
  })

export const ExecutionStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
])

export const ExecutionSchema = z
  .strictObject({
    id: ExecutionIdSchema,
    operationId: OperationIdSchema,
    sandboxId: SandboxIdSchema,
    command: ExecCommandSchema,
    status: ExecutionStatusSchema,
    result: ExecResultSchema.nullable(),
    createdAt: UtcTimestampSchema,
    startedAt: UtcTimestampSchema.nullable(),
    completedAt: UtcTimestampSchema.nullable(),
  })
  .superRefine((execution, context) => {
    if (execution.startedAt !== null && execution.startedAt < execution.createdAt) {
      context.addIssue({ code: 'custom', message: 'Execution cannot start before creation' })
    }
    if (
      execution.completedAt !== null &&
      (execution.completedAt < execution.createdAt ||
        (execution.startedAt !== null && execution.completedAt < execution.startedAt))
    ) {
      context.addIssue({ code: 'custom', message: 'Execution completion time is out of order' })
    }

    if (execution.status === 'queued') {
      if (
        execution.startedAt !== null ||
        execution.completedAt !== null ||
        execution.result !== null
      ) {
        context.addIssue({ code: 'custom', message: 'Queued Execution cannot have terminal data' })
      }
    } else if (execution.status === 'running') {
      if (
        execution.startedAt === null ||
        execution.completedAt !== null ||
        execution.result !== null
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Running Execution requires startedAt and no terminal data',
        })
      }
    } else if (execution.completedAt === null) {
      context.addIssue({ code: 'custom', message: 'Terminal Execution requires completedAt' })
    }

    if (execution.status === 'completed') {
      if (execution.startedAt === null || execution.result === null) {
        context.addIssue({
          code: 'custom',
          path: ['result'],
          message: 'Completed Execution requires start evidence and an ExecResult',
        })
      } else if (
        execution.result.startedAt !== execution.startedAt ||
        execution.result.completedAt !== execution.completedAt
      ) {
        context.addIssue({
          code: 'custom',
          path: ['result'],
          message: 'ExecResult timestamps must match its completed Execution',
        })
      }
    }
    if (execution.status !== 'completed' && execution.result !== null) {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'Only completed remote execution has an ExecResult',
      })
    }
  })

const EventBaseSchema = z.strictObject({
  executionId: ExecutionIdSchema,
  sequence: z.number().int().nonnegative().safe(),
  timestamp: UtcTimestampSchema,
})

export const ExecEventSchema = z.discriminatedUnion('type', [
  EventBaseSchema.extend({ type: z.literal('started') }),
  EventBaseSchema.extend({ type: z.literal('stdout'), data: z.instanceof(Uint8Array) }),
  EventBaseSchema.extend({ type: z.literal('stderr'), data: z.instanceof(Uint8Array) }),
  EventBaseSchema.extend({ type: z.literal('completed'), result: ExecResultSchema }),
])

export interface ExecHandle {
  readonly execution: Execution
  readonly events: AsyncIterable<ExecEvent>
  readonly result: Promise<ExecResult>
}

export type StructuredArgvCommand = z.infer<typeof StructuredArgvCommandSchema>
export type ShellCommand = z.infer<typeof ShellCommandSchema>
export type ExecCommand = z.infer<typeof ExecCommandSchema>
export type ExecRequest = z.infer<typeof ExecRequestSchema>
export type ExecResult = z.infer<typeof ExecResultSchema>
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>
export type Execution = z.infer<typeof ExecutionSchema>
export type ExecEvent = z.infer<typeof ExecEventSchema>

import { z } from 'zod'
import {
  OperationSchema,
  type Operation,
  type OperationContext,
  type RequestContext,
} from '../../domain/operation.js'
import { SandboxIdSchema } from '../../domain/ids.js'
import { SandboxPathSchema } from '../../domain/remote-path.js'
import { UtcTimestampSchema } from '../../domain/timestamps.js'

export const FileEntrySchema = z
  .strictObject({
    path: SandboxPathSchema,
    kind: z.enum(['file', 'directory', 'symlink']),
    sizeBytes: z.number().int().nonnegative().safe(),
    mode: z.number().int().min(0).max(0o7777),
    modifiedAt: UtcTimestampSchema,
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    symlinkTarget: SandboxPathSchema.nullable(),
  })
  .superRefine((entry, context) => {
    if ((entry.kind === 'symlink') !== (entry.symlinkTarget !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['symlinkTarget'],
        message: 'Only symlinks have a symlink target, and every symlink requires one',
      })
    }
  })

export const ReadFileRequestSchema = z.strictObject({
  sandboxId: SandboxIdSchema,
  path: SandboxPathSchema,
  offsetBytes: z.number().int().nonnegative().safe().nullable(),
  lengthBytes: z.number().int().positive().safe().nullable(),
})

export const ReadFileResultSchema = z
  .strictObject({
    entry: FileEntrySchema,
    data: z.instanceof(Uint8Array),
  })
  .superRefine((result, context) => {
    if (result.entry.kind !== 'file') {
      context.addIssue({
        code: 'custom',
        path: ['entry', 'kind'],
        message: 'Read-file results must describe a regular file',
      })
    }
  })

export const WriteFileRequestSchema = z.strictObject({
  sandboxId: SandboxIdSchema,
  path: SandboxPathSchema,
  data: z.instanceof(Uint8Array),
  mode: z.number().int().min(0).max(0o7777).nullable(),
  atomic: z.boolean(),
})

export const ListFilesRequestSchema = z.strictObject({
  sandboxId: SandboxIdSchema,
  path: SandboxPathSchema,
  recursive: z.boolean(),
})

export const StatFileRequestSchema = z.strictObject({
  sandboxId: SandboxIdSchema,
  path: SandboxPathSchema,
})

export const ChecksumFileRequestSchema = z.strictObject({
  sandboxId: SandboxIdSchema,
  path: SandboxPathSchema,
})

export const FileChecksumSchema = z.strictObject({
  algorithm: z.literal('sha256'),
  value: z.string().regex(/^[a-f0-9]{64}$/),
})

export const MakeDirectoryRequestSchema = z.strictObject({
  sandboxId: SandboxIdSchema,
  path: SandboxPathSchema,
  recursive: z.boolean(),
  mode: z.number().int().min(0).max(0o7777).nullable(),
})

export const RemoveFileRequestSchema = z.strictObject({
  sandboxId: SandboxIdSchema,
  path: SandboxPathSchema,
  recursive: z.boolean(),
})

export const MoveFileRequestSchema = z.strictObject({
  sandboxId: SandboxIdSchema,
  from: SandboxPathSchema,
  to: SandboxPathSchema,
  overwrite: z.boolean(),
})

export const FileMutationResultSchema = z
  .strictObject({
    operation: OperationSchema,
    entry: FileEntrySchema.nullable(),
  })
  .superRefine((result, context) => {
    if (
      result.operation.status !== 'succeeded' ||
      !['file_write', 'file_mkdir', 'file_move'].includes(result.operation.action)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['operation'],
        message: 'File mutation results require a successful file mutation Operation',
      })
    }
  })

export type FileEntry = z.infer<typeof FileEntrySchema>
export type ReadFileRequest = z.infer<typeof ReadFileRequestSchema>
export type ReadFileResult = z.infer<typeof ReadFileResultSchema>
export type WriteFileRequest = z.infer<typeof WriteFileRequestSchema>
export type ListFilesRequest = z.infer<typeof ListFilesRequestSchema>
export type StatFileRequest = z.infer<typeof StatFileRequestSchema>
export type ChecksumFileRequest = z.infer<typeof ChecksumFileRequestSchema>
export type FileChecksum = z.infer<typeof FileChecksumSchema>
export type MakeDirectoryRequest = z.infer<typeof MakeDirectoryRequestSchema>
export type RemoveFileRequest = z.infer<typeof RemoveFileRequestSchema>
export type MoveFileRequest = z.infer<typeof MoveFileRequestSchema>
export type FileMutationResult = z.infer<typeof FileMutationResultSchema>

export interface ProviderFiles {
  read(context: RequestContext, request: ReadFileRequest): Promise<ReadFileResult>
  write(context: OperationContext, request: WriteFileRequest): Promise<FileMutationResult>
  list(context: RequestContext, request: ListFilesRequest): Promise<readonly FileEntry[]>
  stat(context: RequestContext, request: StatFileRequest): Promise<FileEntry | null>
  checksum(context: RequestContext, request: ChecksumFileRequest): Promise<FileChecksum>
  makeDirectory(
    context: OperationContext,
    request: MakeDirectoryRequest,
  ): Promise<FileMutationResult>
  remove(context: OperationContext, request: RemoveFileRequest): Promise<Operation>
  move(context: OperationContext, request: MoveFileRequest): Promise<FileMutationResult>
}

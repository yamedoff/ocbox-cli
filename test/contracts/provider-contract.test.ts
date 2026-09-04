import { describe, expect, it } from 'vitest'
import {
  ApplySourceResultSchema,
  type ApplySourceResult,
  type CreatePreviewRequest,
  type CreateSandboxRequest,
  CreateSandboxRequestSchema,
  type ExecEvent,
  type ExecHandle,
  type ExecRequest,
  type FileEntry,
  type FileMutationResult,
  FileMutationResultSchema,
  type GetSandboxRequest,
  type LifecycleMutationRequest,
  type ListSandboxesRequest,
  type Operation,
  type OperationAction,
  type OperationContext,
  OperationSchema,
  PreviewSchema,
  type Preview,
  type ProviderCapabilities,
  type ProviderFiles,
  type ProviderPreviews,
  type ProviderSource,
  type ReadFileRequest,
  type ReadFileResult,
  type RequestContext,
  type RevokePreviewRequest,
  type Sandbox,
  type SandboxMutationResult,
  SandboxMutationResultSchema,
  type SandboxProvider,
  type ApplySourceRequest,
  type StatFileRequest,
  type WriteFileRequest,
  type ListFilesRequest,
  type MakeDirectoryRequest,
  type MoveFileRequest,
  type RemoveFileRequest,
  type CancelExecutionRequest,
  type ChecksumFileRequest,
  type Execution,
  type ExecResult,
  type FileChecksum,
} from '../../src/contracts.js'
import { ids, sandbox, timestamps } from './test-data.js'

const providerCapabilities: ProviderCapabilities = {
  runtimeClasses: ['container'],
  lifecycle: {
    preservesFilesystemOnStop: true,
    supportsMemoryPause: true,
    supportsArchive: false,
  },
  execution: { streaming: true, cancellation: true },
  files: {
    read: true,
    write: true,
    list: true,
    stat: true,
    makeDirectory: true,
    remove: true,
    move: true,
    checksum: true,
  },
  previews: { supported: true, authenticated: true, http: true, websocket: true },
  egressModes: ['open'],
  metadataSearch: true,
  secretExposureModes: ['host_scoped_placeholder'],
  limits: {
    maxCpuMillicores: null,
    maxMemoryBytes: null,
    maxDiskBytes: null,
    maxExecutionMilliseconds: null,
    maxFileBytes: null,
    maxConcurrentExecutions: null,
    maxSandboxes: null,
    maxSandboxesPerSession: 5,
  },
}

function completedOperation(
  context: OperationContext,
  action: OperationAction,
  resolution: Operation['idempotencyResolution'] = { kind: 'created' },
): Operation {
  return OperationSchema.parse({
    id: context.operationId,
    requestId: context.requestId,
    sessionId: ids.session,
    sandboxId: ids.sandbox,
    action,
    status: 'succeeded',
    idempotencyKey: context.idempotencyKey,
    idempotencyResolution: resolution,
    providerVerifiedAt: ['create', 'start', 'pause', 'stop', 'resume', 'destroy'].includes(action)
      ? timestamps.observed
      : null,
    createdAt: timestamps.created,
    startedAt: timestamps.observed,
    completedAt: timestamps.completed,
  })
}

function fileEntry(path: FileEntry['path'], sizeBytes: number): FileEntry {
  return {
    path,
    kind: 'file',
    sizeBytes,
    mode: 0o640,
    modifiedAt: timestamps.completed,
    sha256: 'a'.repeat(64),
    symlinkTarget: null,
  }
}

class FakeProvider implements SandboxProvider {
  readonly name = 'fake'
  private bytes = new Uint8Array()

  readonly exec = {
    execute: (context: OperationContext, request: ExecRequest): Promise<ExecHandle> => {
      const result: ExecResult = {
        exitCode: 17,
        stdout: new Uint8Array([111, 107]),
        stderr: new Uint8Array([101, 114, 114]),
        timedOut: false,
        cancelled: false,
        signal: null,
        startedAt: timestamps.observed,
        completedAt: timestamps.completed,
      }
      const execution: Execution = {
        id: ids.execution,
        operationId: context.operationId,
        sandboxId: request.sandboxId,
        command: request.command,
        status: 'completed',
        result,
        createdAt: timestamps.created,
        startedAt: timestamps.observed,
        completedAt: timestamps.completed,
      }
      async function* events(): AsyncIterable<ExecEvent> {
        yield {
          type: 'completed',
          executionId: ids.execution,
          sequence: 0,
          timestamp: timestamps.completed,
          result,
        }
      }
      return Promise.resolve({ execution, events: events(), result: Promise.resolve(result) })
    },
    cancel: (context: OperationContext, _request: CancelExecutionRequest): Promise<Operation> =>
      Promise.resolve(completedOperation(context, 'exec_cancel')),
  }

  readonly files: ProviderFiles = {
    read: (_context: RequestContext, request: ReadFileRequest): Promise<ReadFileResult> =>
      Promise.resolve({ entry: fileEntry(request.path, this.bytes.byteLength), data: this.bytes }),
    write: (context: OperationContext, request: WriteFileRequest): Promise<FileMutationResult> => {
      this.bytes = new Uint8Array(request.data)
      return Promise.resolve({
        operation: completedOperation(context, 'file_write'),
        entry: fileEntry(request.path, request.data.byteLength),
      })
    },
    list: (_context: RequestContext, request: ListFilesRequest): Promise<readonly FileEntry[]> =>
      Promise.resolve([fileEntry(request.path, this.bytes.byteLength)]),
    stat: (_context: RequestContext, request: StatFileRequest): Promise<FileEntry | null> =>
      Promise.resolve(fileEntry(request.path, this.bytes.byteLength)),
    checksum: (_context: RequestContext, _request: ChecksumFileRequest): Promise<FileChecksum> =>
      Promise.resolve({ algorithm: 'sha256', value: 'a'.repeat(64) }),
    makeDirectory: (
      context: OperationContext,
      _request: MakeDirectoryRequest,
    ): Promise<FileMutationResult> =>
      Promise.resolve({ operation: completedOperation(context, 'file_mkdir'), entry: null }),
    remove: (context: OperationContext, _request: RemoveFileRequest): Promise<Operation> =>
      Promise.resolve(completedOperation(context, 'file_remove')),
    move: (context: OperationContext, request: MoveFileRequest): Promise<FileMutationResult> =>
      Promise.resolve({
        operation: completedOperation(context, 'file_move'),
        entry: fileEntry(request.to, this.bytes.byteLength),
      }),
  }

  readonly source: ProviderSource = {
    apply: (context: OperationContext, request: ApplySourceRequest): Promise<ApplySourceResult> =>
      Promise.resolve({
        operation: completedOperation(context, 'source_apply'),
        sandboxId: request.sandboxId,
        contentDigestSha256: 'b'.repeat(64),
      }),
  }

  readonly previews: ProviderPreviews = {
    create: (context: OperationContext, request: CreatePreviewRequest): Promise<Preview> =>
      Promise.resolve({
        operation: completedOperation(context, 'preview_create'),
        sandboxId: request.sandboxId,
        port: request.port,
        protocol: request.protocol,
        url: `${request.protocol}://preview.example.test:${request.port}`,
        authenticated: true,
        expiresAt: timestamps.completed,
      }),
    revoke: (context: OperationContext, _request: RevokePreviewRequest): Promise<Operation> =>
      Promise.resolve(completedOperation(context, 'preview_revoke')),
  }

  capabilities(_context: RequestContext): Promise<ProviderCapabilities> {
    return Promise.resolve(providerCapabilities)
  }

  create(context: OperationContext, request: CreateSandboxRequest): Promise<SandboxMutationResult> {
    const resolution =
      context.attempt === 1
        ? ({ kind: 'created' } as const)
        : ({
            kind: 'adopted_existing',
            providerSandboxId: ids.providerSandbox,
            originalOperationId: request.adoption.metadata.operationId,
          } as const)
    return Promise.resolve({
      operation: completedOperation(context, 'create', resolution),
      sandbox,
    })
  }

  get(_context: RequestContext, _request: GetSandboxRequest): Promise<Sandbox | null> {
    return Promise.resolve(sandbox)
  }

  list(_context: RequestContext, _request: ListSandboxesRequest): Promise<readonly Sandbox[]> {
    return Promise.resolve([sandbox])
  }

  start(
    context: OperationContext,
    _request: LifecycleMutationRequest,
  ): Promise<SandboxMutationResult> {
    return Promise.resolve({ operation: completedOperation(context, 'start'), sandbox })
  }

  pause(
    context: OperationContext,
    _request: LifecycleMutationRequest,
  ): Promise<SandboxMutationResult> {
    return Promise.resolve({ operation: completedOperation(context, 'pause'), sandbox })
  }

  resume(
    context: OperationContext,
    _request: LifecycleMutationRequest,
  ): Promise<SandboxMutationResult> {
    return Promise.resolve({ operation: completedOperation(context, 'resume'), sandbox })
  }

  stop(
    context: OperationContext,
    _request: LifecycleMutationRequest,
  ): Promise<SandboxMutationResult> {
    return Promise.resolve({ operation: completedOperation(context, 'stop'), sandbox })
  }

  destroy(
    context: OperationContext,
    _request: LifecycleMutationRequest,
  ): Promise<SandboxMutationResult> {
    return Promise.resolve({ operation: completedOperation(context, 'destroy'), sandbox })
  }
}

const requestContext: RequestContext = {
  requestId: ids.request,
  issuedAt: timestamps.created,
}

const operationContext: OperationContext = {
  ...requestContext,
  operationId: ids.operation,
  idempotencyKey: ids.idempotency,
  attempt: 1,
}

describe('SandboxProvider contract', () => {
  it('compiles and exposes every provider-neutral surface', async () => {
    const provider: SandboxProvider = new FakeProvider()
    await expect(provider.capabilities(requestContext)).resolves.toEqual(providerCapabilities)
    await expect(provider.get(requestContext, { sandboxId: ids.sandbox })).resolves.toEqual(sandbox)
    expect(provider.exec).toBeDefined()
    expect(provider.files).toBeDefined()
    expect(provider.source).toBeDefined()
    expect(provider.previews).toBeDefined()
  })

  it('normalizes source and authenticated preview results through nested ports', async () => {
    const provider = new FakeProvider()
    const sourceResult = await provider.source.apply(operationContext, {
      sandboxId: ids.sandbox,
      source: sandbox.specification.requested.source,
    })
    expect(ApplySourceResultSchema.parse(sourceResult).contentDigestSha256).toBe('b'.repeat(64))

    const preview = await provider.previews.create(operationContext, {
      sandboxId: ids.sandbox,
      port: 3_000,
      protocol: 'https',
      expiresInMilliseconds: 60_000,
    })
    expect(PreviewSchema.parse(preview).authenticated).toBe(true)
    expect(PreviewSchema.safeParse({ ...preview, authenticated: false }).success).toBe(false)
  })

  it('models duplicate create as adoption under the original operation metadata', async () => {
    const provider = new FakeProvider()
    const request: CreateSandboxRequest = {
      projectId: ids.project,
      sessionId: ids.session,
      specification: sandbox.specification.requested,
      adoption: {
        strategy: 'metadata_search_then_adopt',
        metadata: { sessionId: ids.session, operationId: ids.operation },
      },
    }

    const first = await provider.create(operationContext, request)
    const duplicate = await provider.create({ ...operationContext, attempt: 2 }, request)
    expect(SandboxMutationResultSchema.parse(first)).toEqual(first)
    expect(first.operation.idempotencyResolution).toEqual({ kind: 'created' })
    expect(duplicate.operation.idempotencyResolution).toEqual({
      kind: 'adopted_existing',
      providerSandboxId: ids.providerSandbox,
      originalOperationId: ids.operation,
    })
  })

  it('rejects create adoption metadata for a different Session', () => {
    expect(
      CreateSandboxRequestSchema.safeParse({
        projectId: ids.project,
        sessionId: ids.session,
        specification: sandbox.specification.requested,
        adoption: {
          strategy: 'metadata_search_then_adopt',
          metadata: {
            sessionId: '88888888-8888-4888-8888-888888888888',
            operationId: ids.operation,
          },
        },
      }).success,
    ).toBe(false)
  })

  it('preserves binary file bytes through the fake provider surface', async () => {
    const provider = new FakeProvider()
    const bytes = new Uint8Array([0, 255, 128, 13, 10])
    const write = await provider.files.write(operationContext, {
      sandboxId: ids.sandbox,
      path: '/workspace/blob.bin' as WriteFileRequest['path'],
      data: bytes,
      mode: 0o640,
      atomic: true,
    })
    expect(FileMutationResultSchema.parse(write)).toEqual(write)
    const read = await provider.files.read(requestContext, {
      sandboxId: ids.sandbox,
      path: '/workspace/blob.bin' as ReadFileRequest['path'],
      offsetBytes: null,
      lengthBytes: null,
    })
    expect([...read.data]).toEqual([...bytes])
    await expect(
      provider.files.checksum(requestContext, {
        sandboxId: ids.sandbox,
        path: '/workspace/blob.bin' as ReadFileRequest['path'],
      }),
    ).resolves.toEqual({ algorithm: 'sha256', value: 'a'.repeat(64) })
  })

  it('returns a remote nonzero command result without throwing infrastructure error', async () => {
    const provider = new FakeProvider()
    const handle = await provider.exec.execute(operationContext, {
      sandboxId: ids.sandbox,
      command: { mode: 'argv', argv: ['false'] },
      workingDirectory: null,
      timeoutMilliseconds: null,
    })
    await expect(handle.result).resolves.toMatchObject({ exitCode: 17 })
  })
})

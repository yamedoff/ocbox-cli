import { randomUUID } from 'node:crypto'
import {
  ExecutionIdSchema,
  ExecutionSchema,
  ExecRequestSchema,
  type ExecEvent,
  type ExecHandle,
  type ExecRequest,
  type ExecResult,
  type OperationContext,
} from '../contracts.js'
import { runExecutionHelper } from './helper-runtime.js'

interface PendingPush<T> {
  readonly value: T
  readonly resolve: () => void
  readonly reject: (reason: unknown) => void
}

/** A small async queue whose producer blocks when the consumer falls behind. */
class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  readonly #capacity: number
  readonly #values: T[] = []
  readonly #pushers: PendingPush<T>[] = []
  readonly #readers: Array<(result: IteratorResult<T>) => void> = []
  #ended = false
  #failure: unknown

  constructor(capacity: number) {
    this.#capacity = capacity
  }

  push(value: T): Promise<void> {
    if (this.#ended) return Promise.reject(this.#failure ?? new Error('Execution queue ended'))
    const reader = this.#readers.shift()
    if (reader !== undefined) {
      reader({ done: false, value })
      return Promise.resolve()
    }
    if (this.#values.length < this.#capacity) {
      this.#values.push(value)
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => this.#pushers.push({ value, resolve, reject }))
  }

  end(failure?: unknown): void {
    this.#ended = true
    this.#failure = failure
    const terminal = failure ?? new Error('Execution queue ended')
    for (const pusher of this.#pushers.splice(0)) pusher.reject(terminal)
    for (const reader of this.#readers.splice(0)) reader({ done: true, value: undefined })
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift()
    if (value !== undefined) {
      const pusher = this.#pushers.shift()
      if (pusher !== undefined) {
        this.#values.push(pusher.value)
        pusher.resolve()
      }
      return { done: false, value }
    }
    if (this.#ended) {
      if (this.#failure !== undefined) throw this.#failure
      return { done: true, value: undefined }
    }
    return new Promise<IteratorResult<T>>((resolve) => this.#readers.push(resolve))
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }

  return(): Promise<IteratorResult<T>> {
    this.end(new Error('Execution event consumer stopped'))
    return Promise.resolve({ done: true, value: undefined })
  }
}

export interface LocalProcessExecution {
  readonly handle: ExecHandle
  cancel(): void
}

export interface LocalProcessHarnessOptions {
  readonly queueCapacity?: number
  readonly now?: () => Date
  readonly createId?: () => string
  readonly workingDirectory?: string
  readonly supportsBash?: boolean
}

/**
 * Host-process harness for provider contract tests. It is deliberately not a
 * sandbox adapter and must never be presented to users as remote isolation.
 */
export class LocalProcessExecutionHarness {
  readonly #queueCapacity: number
  readonly #now: () => Date
  readonly #createId: () => string
  readonly #workingDirectory: string | undefined
  readonly #supportsBash: boolean

  constructor(options: LocalProcessHarnessOptions = {}) {
    this.#queueCapacity = options.queueCapacity ?? 8
    if (!Number.isSafeInteger(this.#queueCapacity) || this.#queueCapacity < 1) {
      throw new RangeError('Execution queue capacity must be a positive integer')
    }
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? randomUUID
    this.#workingDirectory = options.workingDirectory
    this.#supportsBash = options.supportsBash ?? process.platform !== 'win32'
  }

  execute(context: OperationContext, requestValue: ExecRequest): LocalProcessExecution {
    const request = ExecRequestSchema.parse(requestValue)
    const executionId = ExecutionIdSchema.parse(this.#createId())
    const startedAt = this.#now().toISOString()
    const queue = new BoundedAsyncQueue<ExecEvent>(this.#queueCapacity)
    const cancellation = new AbortController()
    const execution = ExecutionSchema.parse({
      id: executionId,
      operationId: context.operationId,
      sandboxId: request.sandboxId,
      command: request.command,
      status: 'running',
      result: null,
      createdAt: startedAt,
      startedAt,
      completedAt: null,
    })
    const helperRequest = {
      version: 1 as const,
      executionId,
      command: request.command,
      workingDirectory: request.workingDirectory,
      environment: request.environment,
      timeoutMilliseconds: request.timeoutMilliseconds,
    }
    const result: Promise<ExecResult> = runExecutionHelper(
      helperRequest,
      (event) => queue.push(event),
      {
        supportsBash: this.#supportsBash,
        signal: cancellation.signal,
        ...(this.#workingDirectory === undefined
          ? {}
          : { localWorkingDirectory: this.#workingDirectory }),
        now: this.#now,
      },
    ).then(
      (value) => {
        queue.end()
        return value
      },
      (error: unknown) => {
        queue.end(error)
        throw error
      },
    )
    return {
      handle: { execution, events: queue, result },
      cancel: () => cancellation.abort(),
    }
  }
}

import { spawn, type ChildProcess } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import type { ExecEvent, ExecResult } from '../domain/execution.js'
import type { UtcTimestamp } from '../domain/timestamps.js'
import { helperSpawnArguments, type HelperRequest } from './helper-protocol.js'

export type HelperCancellationReason = 'cancelled' | 'timeout'

export type ExecutionStartFailure = 'not_found' | 'permission_denied' | 'spawn_failed'

/** Safe, typed failure emitted when the workload process never starts. */
export class ExecutionStartError extends Error {
  readonly code = 'EXECUTION_START_FAILED'
  readonly failure: ExecutionStartFailure

  constructor(failure: ExecutionStartFailure) {
    super('Execution failed before the workload process started')
    this.name = 'ExecutionStartError'
    this.failure = failure
  }
}

export interface HelperRuntimeOptions {
  readonly supportsBash: boolean
  readonly signal?: AbortSignal
  readonly cancellationReason?: () => HelperCancellationReason
  readonly now?: () => Date
  readonly platform?: NodeJS.Platform
  readonly spawnProcess?: typeof spawn
  /** Used only by the explicitly local test harness; production helpers use the request path. */
  readonly localWorkingDirectory?: string
  readonly cancellationGraceMilliseconds?: number
}

function exitCodeForSignal(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1
  const number = osConstants.signals[signal]
  return Math.min(255, 128 + (number ?? 1))
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined
}

function startFailure(error: unknown): ExecutionStartFailure {
  switch (errorCode(error)) {
    case 'ENOENT':
      return 'not_found'
    case 'EACCES':
    case 'EPERM':
      return 'permission_denied'
    default:
      return 'spawn_failed'
  }
}

function terminateTree(child: ChildProcess, platform: NodeJS.Platform, force: boolean): void {
  if (child.pid === undefined) return
  if (platform === 'win32') {
    // Windows has no portable graceful process-group signal. `/t /f` is the
    // documented tree termination primitive and avoids leaving descendants.
    const args = ['/pid', String(child.pid), '/t', '/f']
    const killer = spawn('taskkill.exe', args, { shell: false, stdio: 'ignore', windowsHide: true })
    killer.unref()
    return
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM')
    } catch {
      // The process may have become terminal between observation and cancellation.
    }
  }
}

/**
 * Runs one request inside the helper process. This is the only workload spawn
 * point: argv is passed as a vector and shell evaluation is always disabled.
 */
export async function runExecutionHelper(
  request: HelperRequest,
  emit: (event: ExecEvent) => Promise<void>,
  options: HelperRuntimeOptions,
): Promise<ExecResult> {
  const now = options.now ?? (() => new Date())
  const platform = options.platform ?? process.platform
  const spawnProcess = options.spawnProcess ?? spawn
  let sequence = 0
  let terminal = false
  const { executable, args } = helperSpawnArguments(request, options.supportsBash)
  let child: ChildProcess
  try {
    child = spawnProcess(executable, [...args], {
      cwd: options.localWorkingDirectory ?? request.workingDirectory ?? undefined,
      env: { ...process.env, ...request.environment },
      detached: platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    throw new ExecutionStartError(startFailure(error))
  }

  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', (error) => reject(new ExecutionStartError(startFailure(error))))
  })
  const terminalOutcome = new Promise<
    | {
        readonly kind: 'exit'
        readonly code: number | null
        readonly signal: NodeJS.Signals | null
      }
    | { readonly kind: 'error'; readonly error: unknown }
  >((resolve) => {
    child.once('error', (error) => resolve({ kind: 'error', error }))
    child.once('close', (code, signal) => resolve({ kind: 'exit', code, signal }))
  })
  await spawned
  const startedAt = now().toISOString() as UtcTimestamp
  try {
    await emit({
      type: 'started',
      executionId: request.executionId,
      sequence: sequence++,
      timestamp: startedAt,
    })
  } catch (error) {
    terminateTree(child, platform, true)
    await terminalOutcome
    throw error
  }

  const finishAt = (): UtcTimestamp => {
    const candidate = now().toISOString()
    return (candidate < startedAt ? startedAt : candidate) as UtcTimestamp
  }

  const writeChunk = async (stream: 'stdout' | 'stderr', data: Buffer): Promise<void> => {
    await emit({
      type: stream,
      executionId: request.executionId,
      sequence: sequence++,
      timestamp: finishAt(),
      data: new Uint8Array(data),
    })
  }

  const stdoutPump = (async () => {
    if (child.stdout === null) return
    for await (const chunk of child.stdout) await writeChunk('stdout', Buffer.from(chunk))
  })().catch((error: unknown) => {
    terminateTree(child, platform, true)
    throw error
  })
  const stderrPump = (async () => {
    if (child.stderr === null) return
    for await (const chunk of child.stderr) await writeChunk('stderr', Buffer.from(chunk))
  })().catch((error: unknown) => {
    terminateTree(child, platform, true)
    throw error
  })

  let cancellationReason: HelperCancellationReason | undefined
  let forceTimer: NodeJS.Timeout | undefined
  const cancel = (): void => {
    if (terminal || cancellationReason !== undefined) return
    cancellationReason = options.cancellationReason?.() ?? 'cancelled'
    terminateTree(child, platform, false)
    forceTimer = setTimeout(
      () => terminateTree(child, platform, true),
      options.cancellationGraceMilliseconds ?? 500,
    )
    forceTimer.unref()
  }
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted === true) cancel()

  let timeout: NodeJS.Timeout | undefined
  if (request.timeoutMilliseconds !== null) {
    timeout = setTimeout(() => {
      if (terminal || cancellationReason !== undefined) return
      cancellationReason = 'timeout'
      terminateTree(child, platform, false)
      forceTimer = setTimeout(
        () => terminateTree(child, platform, true),
        options.cancellationGraceMilliseconds ?? 500,
      )
      forceTimer.unref()
    }, request.timeoutMilliseconds)
    timeout.unref()
  }

  const outcome = await terminalOutcome
  terminal = true
  if (timeout !== undefined) clearTimeout(timeout)
  if (forceTimer !== undefined) clearTimeout(forceTimer)
  options.signal?.removeEventListener('abort', cancel)
  await Promise.all([stdoutPump, stderrPump])

  if (outcome.kind === 'error') throw new ExecutionStartError(startFailure(outcome.error))
  const completedAt = finishAt()
  const signal = outcome.signal
  const result: ExecResult = {
    exitCode:
      cancellationReason === 'timeout'
        ? 124
        : cancellationReason === 'cancelled'
          ? 130
          : outcome.code === null
            ? exitCodeForSignal(signal)
            : outcome.code,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    timedOut: cancellationReason === 'timeout',
    cancelled: cancellationReason === 'cancelled',
    signal,
    startedAt,
    completedAt,
  }
  await emit({
    type: 'completed',
    executionId: request.executionId,
    sequence: sequence++,
    timestamp: completedAt,
    result,
  })
  return result
}

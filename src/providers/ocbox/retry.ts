/**
 * Deterministic retry/backoff/deadline primitives for hosted Operation and
 * Execution polling. All time sources, jitter randomness, and sleepers are
 * injectable so contract tests never depend on wall-clock behavior.
 */

export interface RetryPolicy {
  readonly baseMilliseconds: number
  readonly maxMilliseconds: number
  readonly multiplier: number
  readonly jitterRatio: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseMilliseconds: 250,
  maxMilliseconds: 30_000,
  multiplier: 2,
  jitterRatio: 0.2,
}

const MAX_RETRY_AFTER_SECONDS = 86_400

/**
 * Parses an RFC 9110 `Retry-After` value: either delay-seconds or an HTTP-date.
 * Values outside a sane one-day ceiling are ignored so a hostile header cannot
 * stall the CLI indefinitely.
 */
export function parseRetryAfterSeconds(
  value: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) {
    if (seconds > MAX_RETRY_AFTER_SECONDS) return null
    return Math.trunc(seconds)
  }
  const instant = Date.parse(trimmed)
  if (Number.isNaN(instant)) return null
  const delta = Math.ceil((instant - now.valueOf()) / 1_000)
  if (delta < 0 || delta > MAX_RETRY_AFTER_SECONDS) return null
  return delta
}

/**
 * Exponential backoff with additive jitter, bounded by the policy ceiling.
 * `attempt` is one-based; `random` defaults to `Math.random` but is injected in
 * tests to keep delays exact.
 */
export function computeBackoffMilliseconds(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError('The retry attempt must be a positive integer')
  }
  const exponent = Math.min(attempt - 1, 30)
  const ideal = policy.baseMilliseconds * policy.multiplier ** exponent
  const capped = Math.min(ideal, policy.maxMilliseconds)
  if (policy.jitterRatio <= 0) return Math.round(capped)
  const jitter = capped * policy.jitterRatio * random()
  return Math.round(Math.min(capped + jitter, policy.maxMilliseconds))
}

export interface PollDelayInput {
  readonly retryAfterSeconds: number | null
  readonly attempt: number
  readonly policy?: RetryPolicy | undefined
  readonly random?: (() => number) | undefined
}

/**
 * Resolves the next poll delay. A server `Retry-After` hint always wins over
 * computed backoff, because the server is authoritative about its own
 * capacity; the deadline (not the delay) bounds how long the CLI is willing to
 * wait.
 */
export function resolvePollDelayMilliseconds(input: PollDelayInput): number {
  if (
    input.retryAfterSeconds !== null &&
    Number.isFinite(input.retryAfterSeconds) &&
    input.retryAfterSeconds >= 0
  ) {
    return Math.trunc(input.retryAfterSeconds) * 1_000
  }
  return computeBackoffMilliseconds(input.attempt, input.policy, input.random)
}

/**
 * Absolute deadline shared across a wait call. It uses an injected epoch
 * millisecond clock so a fake clock can advance deterministically.
 */
export class Deadline {
  readonly #now: () => number
  readonly #expiresAt: number

  constructor(milliseconds: number, now: () => number = Date.now) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError('The deadline must be a non-negative number of milliseconds')
    }
    this.#now = now
    this.#expiresAt = now() + milliseconds
  }

  remainingMilliseconds(): number {
    return Math.max(0, this.#expiresAt - this.#now())
  }

  exceeded(): boolean {
    return this.#now() >= this.#expiresAt
  }

  expiresAt(): number {
    return this.#expiresAt
  }
}

export function abortError(): Error {
  const error = new Error('The hosted request was aborted')
  error.name = 'AbortError'
  return error
}

/** Abort-aware sleep that resolves immediately when the signal is aborted. */
export function sleepWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError())
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

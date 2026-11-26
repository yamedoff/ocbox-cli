/**
 * Opt-in phase tracing for `ocbox` commands.
 *
 * `OCBOX_TRACE=1` makes the CLI write one stderr line per phase with the
 * elapsed milliseconds since process start. The switch is read once when this
 * module loads, so the default path is a single boolean check per call and no
 * timers, formatting, or writes. Trace lines never carry credentials: HTTP
 * paths lose their query string, host and identifier-shaped segments, and the
 * only request facts printed are method, path, status and duration.
 */
const TRACE_ENV = 'OCBOX_TRACE'

export const TRACE_ENV_NAME = TRACE_ENV
export const TRACE_PREFIX = 'ocbox-trace'

export type TraceValue = string | number | boolean

export interface TraceFields {
  /** How long this phase took; omitted for point-in-time markers. */
  readonly durationMs?: number | undefined
  readonly [key: string]: TraceValue | undefined
}

export interface TraceSink {
  write(chunk: string): unknown
}

export interface TracerOptions {
  readonly enabled: boolean
  readonly stderr?: TraceSink | undefined
  readonly now?: (() => number) | undefined
}

export interface Tracer {
  readonly enabled: boolean
  /** Number of HTTP attempts observed through the traced global fetch. */
  readonly httpRequestCount: number
  /** Prints one phase line; a no-op when tracing is disabled. */
  phase(name: string, fields?: TraceFields): void
  /** Prints one HTTP line; a no-op when tracing is disabled. */
  http(method: string, url: string | URL, status: number, durationMilliseconds: number): void
  /** Records one network attempt before the request is sent. */
  countHttpRequest(): void
}

/** True only for the documented opt-in value; every other value stays off. */
export function traceRequested(environment: NodeJS.ProcessEnv = process.env): boolean {
  // Environment is an index signature; bracket access is required by TypeScript.
  return environment[TRACE_ENV] === '1'
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PREFIXED_ID_SEGMENT = /^[a-z]{2,10}_[A-Za-z0-9_-]{3,}$/
const LONG_HEX_SEGMENT = /^[0-9a-f]{16,}$/i
const NUMERIC_SEGMENT = /^\d+$/
const OPAQUE_SEGMENT = /^(?=.*[0-9])[A-Za-z0-9_-]{12,}$/
const LONG_SEGMENT = /^[A-Za-z0-9_-]{24,}$/

function isIdentifierSegment(segment: string): boolean {
  return (
    UUID_SEGMENT.test(segment) ||
    PREFIXED_ID_SEGMENT.test(segment) ||
    LONG_HEX_SEGMENT.test(segment) ||
    NUMERIC_SEGMENT.test(segment) ||
    OPAQUE_SEGMENT.test(segment) ||
    LONG_SEGMENT.test(segment)
  )
}

/**
 * Returns the request path with identifiers replaced by `:id` and every query
 * or fragment removed, so a trace can be read without exposing an account,
 * project, Session, execution or token identifier.
 */
export function pathWithoutIds(url: string | URL): string {
  let pathname: string
  try {
    pathname = (url instanceof URL ? url : new URL(url)).pathname
  } catch {
    // A relative URL still has a useful path; drop any query/fragment first.
    pathname = String(url).split(/[?#]/, 1)[0] ?? '/'
  }
  if (pathname === '') return '/'
  return pathname
    .split('/')
    .map((segment) => (isIdentifierSegment(segment) ? ':id' : segment))
    .join('/')
}

/** Keeps every emitted token on one whitespace-free, parser-safe line. */
function safeValue(value: TraceValue): string {
  return String(value).replace(/[^A-Za-z0-9._:/{}-]/g, '_')
}

function integer(value: number): number {
  return Math.max(0, Math.round(value))
}

class TraceWriter implements Tracer {
  readonly enabled: boolean
  readonly #stderr: TraceSink
  readonly #now: () => number
  #httpRequests = 0

  constructor(options: TracerOptions) {
    this.enabled = options.enabled
    this.#stderr = options.stderr ?? process.stderr
    this.#now = options.now ?? (() => performance.now())
  }

  get httpRequestCount(): number {
    return this.#httpRequests
  }

  countHttpRequest(): void {
    if (!this.enabled) return
    this.#httpRequests += 1
  }

  phase(name: string, fields: TraceFields = {}): void {
    if (!this.enabled) return
    const parts = [`phase=${safeValue(name)}`, `elapsed_ms=${integer(this.#now())}`]
    if (fields.durationMs !== undefined) {
      parts.push(`duration_ms=${integer(fields.durationMs)}`)
    }
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'durationMs' || value === undefined) continue
      parts.push(`${safeValue(key)}=${safeValue(value)}`)
    }
    this.#stderr.write(`${TRACE_PREFIX} ${parts.join(' ')}\n`)
  }

  http(method: string, url: string | URL, status: number, durationMilliseconds: number): void {
    if (!this.enabled) return
    this.phase('http', {
      durationMs: durationMilliseconds,
      method: method.toUpperCase(),
      path: pathWithoutIds(url),
      status,
    })
  }
}

export function createTracer(options: TracerOptions): Tracer {
  return new TraceWriter(options)
}

/** The process-wide tracer; disabled unless `OCBOX_TRACE=1` was set at load. */
export const trace: Tracer = createTracer({ enabled: traceRequested() })

let fetchTraceInstalled = false

/**
 * Wraps `globalThis.fetch` so every request the CLI sends — the startup
 * version gate, token refresh and product calls alike — produces one line and
 * increments the tracer's network counter. Does nothing when tracing is off.
 * Returns a dispose function so tests can restore the process-global fetch.
 */
export function installHttpTrace(tracer: Tracer = trace): () => void {
  if (!tracer.enabled || fetchTraceInstalled || typeof globalThis.fetch !== 'function') {
    return () => {}
  }
  fetchTraceInstalled = true
  const original = globalThis.fetch
  globalThis.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const url = input instanceof Request ? input.url : String(input)
    tracer.countHttpRequest()
    const started = performance.now()
    try {
      const response = await original(...args)
      tracer.http(method, url, response.status, performance.now() - started)
      return response
    } catch (error) {
      // No response arrived; status 0 says so without inventing a server code.
      tracer.http(method, url, 0, performance.now() - started)
      throw error
    }
  }
  return () => {
    globalThis.fetch = original
    fetchTraceInstalled = false
  }
}

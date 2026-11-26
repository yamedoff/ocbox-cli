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
  /** Prints one HTTP line from a URL; a no-op when tracing is disabled. */
  http(method: string, url: string | URL, status: number, durationMilliseconds: number): void
  /** Prints one HTTP line from an already-redacted path. */
  httpPath(method: string, path: string, status: number, durationMilliseconds: number): void
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
const MIXED_CASE_SEGMENT = /^(?=.*[a-z])(?=.*[A-Z])[A-Za-z0-9_-]{8,}$/
const LONG_SEGMENT = /^[A-Za-z0-9_-]{14,}$/

/**
 * Collection segments whose next path segment is a path parameter, taken from
 * the vendored `/v1` routes. This catches short opaque IDs that no shape
 * heuristic would recognise (for example `PreviewId` or `ManifestId`).
 */
const ID_PREDECESSORS = new Set([
  'checkout',
  'chunks',
  'environments',
  'executions',
  'installations',
  'manifests',
  'operations',
  'previews',
  'projects',
  'reservations',
  'secret-references',
  'sessions',
  'snapshots',
])

function isIdentifierSegment(segment: string): boolean {
  return (
    UUID_SEGMENT.test(segment) ||
    PREFIXED_ID_SEGMENT.test(segment) ||
    LONG_HEX_SEGMENT.test(segment) ||
    NUMERIC_SEGMENT.test(segment) ||
    OPAQUE_SEGMENT.test(segment) ||
    MIXED_CASE_SEGMENT.test(segment) ||
    LONG_SEGMENT.test(segment)
  )
}

/** A request outside the configured hosted API; its URL is never printed. */
export const EXTERNAL_PATH = ':external'

/**
 * Parses an absolute request URL. Relative strings are not resolved against a
 * base: the CLI only sends absolute URLs, and a host-looking string must never
 * be mistaken for a path.
 */
export function parseRequestUrl(url: string | URL): URL | undefined {
  if (url instanceof URL) return url
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

/**
 * Returns the request path with identifiers replaced by `:id` and every query
 * or fragment removed, so a trace can be read without exposing an account,
 * project, Session, execution or token identifier. A URL that cannot be parsed
 * is reduced to `/`; its host is never echoed.
 */
export function pathWithoutIds(url: string | URL): string {
  const parsed = parseRequestUrl(url)
  let pathname: string
  if (parsed !== undefined) {
    pathname = parsed.pathname
  } else {
    const raw = String(url)
    // Only a rooted path is safe to echo; `//host/path` and `host/path` are not.
    pathname = raw.startsWith('/') && !raw.startsWith('//') ? (raw.split(/[?#]/, 1)[0] ?? '/') : '/'
  }
  if (pathname === '') return '/'
  const segments = pathname.split('/')
  return segments
    .map((segment, index) => {
      const previous = index > 0 ? segments[index - 1] : undefined
      const followsCollection = previous !== undefined && ID_PREDECESSORS.has(previous)
      return followsCollection || isIdentifierSegment(segment) ? ':id' : segment
    })
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

  phase(name: string, fields?: TraceFields): void {
    if (!this.enabled) return
    const values = fields ?? {}
    const parts = [`phase=${safeValue(name)}`, `elapsed_ms=${integer(this.#now())}`]
    if (values.durationMs !== undefined) {
      parts.push(`duration_ms=${integer(values.durationMs)}`)
    }
    for (const [key, value] of Object.entries(values)) {
      if (key === 'durationMs' || value === undefined) continue
      parts.push(`${safeValue(key)}=${safeValue(value)}`)
    }
    try {
      this.#stderr.write(`${TRACE_PREFIX} ${parts.join(' ')}\n`)
    } catch {
      /* Tracing is diagnostic: it must never change a command's exit status. */
    }
  }

  http(method: string, url: string | URL, status: number, durationMilliseconds: number): void {
    if (!this.enabled) return
    this.httpPath(method, pathWithoutIds(url), status, durationMilliseconds)
  }

  httpPath(method: string, path: string, status: number, durationMilliseconds: number): void {
    if (!this.enabled) return
    this.phase('http', {
      durationMs: durationMilliseconds,
      method: method.toUpperCase(),
      path,
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

export interface HttpTraceOptions {
  /**
   * True when the URL belongs to the configured hosted API. Requests outside
   * it (for example short-lived CAS upload/download capabilities) are printed
   * as `:external`, never with their path, host or query string. Defaults to
   * false so a caller that forgets the predicate cannot leak a capability URL.
   */
  readonly isApiUrl?: ((url: URL) => boolean) | undefined
}

/**
 * Wraps `globalThis.fetch` so every request the CLI sends — the startup
 * version gate, token refresh and product calls alike — produces one line and
 * increments the tracer's network counter. Only requests on the configured
 * API origin keep their (id-free) path; every other URL is `:external`. Does
 * nothing when tracing is off. Returns a dispose function so tests can restore
 * the process-global fetch.
 */
export function installHttpTrace(
  tracer: Tracer = trace,
  options: HttpTraceOptions = {},
): () => void {
  if (!tracer.enabled || fetchTraceInstalled || typeof globalThis.fetch !== 'function') {
    return () => {}
  }
  fetchTraceInstalled = true
  const original = globalThis.fetch
  const isApiUrl = options.isApiUrl ?? (() => false)
  globalThis.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const url = input instanceof Request ? input.url : String(input)
    const parsed = parseRequestUrl(url)
    // A credential-less request is a capability exchange (for example a CAS
    // upload/download URL), even when it shares the API origin. Never print it.
    const credentialless =
      init?.credentials === 'omit' || (input instanceof Request && input.credentials === 'omit')
    const path =
      credentialless || parsed === undefined || !isApiUrl(parsed)
        ? EXTERNAL_PATH
        : pathWithoutIds(parsed)
    tracer.countHttpRequest()
    const started = performance.now()
    try {
      const response = await original(...args)
      tracer.httpPath(method, path, response.status, performance.now() - started)
      return response
    } catch (error) {
      // No response arrived; status 0 says so without inventing a server code.
      tracer.httpPath(method, path, 0, performance.now() - started)
      throw error
    }
  }
  return () => {
    globalThis.fetch = original
    fetchTraceInstalled = false
  }
}

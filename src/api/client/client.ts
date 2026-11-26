import {
  createClient,
  type ApiResult,
  type ApiTransport,
  type OpenCloudBoxClient,
} from '../generated/client.js'
import { createAuthenticatedTransport } from '../../auth/hosted-client.js'
import {
  DEFAULT_HTTP_TIMEOUT_MILLISECONDS,
  type HostedProtocolEndpoints,
} from '../../auth/config.js'
import type { FetchPort } from '../../auth/ports.js'
import type { HostedTokenManager } from '../../auth/token-manager.js'
import type { OcboxError } from '../../errors/index.js'
import { newRequestId } from '../../auth/errors.js'
import { trace, type Tracer } from '../../cli/trace.js'
import { envelopeOf, mapApiFailureToOcboxError } from './errors.js'

export const OCBOX_CLI_USER_AGENT = 'ocbox-cli/0.1.0' as const

export interface OcboxApiClientOptions {
  readonly protocol: HostedProtocolEndpoints
  readonly tokens: HostedTokenManager
  readonly fetch?: FetchPort | undefined
  readonly timeoutMilliseconds?: number | undefined
  readonly maxResponseBytes?: number | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
}

export interface ApiCallMetadata {
  readonly operation: string
  readonly requestId: string | null
  readonly replay: boolean
  readonly status: number
}

/** The project session list query; `includeDestroyed` postdates the pin. */
export interface SessionListQuery {
  readonly projectId: string
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
  readonly includeDestroyed?: boolean | undefined
}

/** The read-only GPU check query, in the units the hosted route names. */
export interface GpuCheckQuery {
  readonly gpuType: string
  readonly gpuCount: number
  readonly lifetimeSeconds?: number | undefined
  readonly cpu?: number | undefined
  readonly memoryMib?: number | undefined
  readonly diskGib?: number | undefined
}

function withoutManagedHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (headers === undefined) return undefined
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase()
    if (normalized !== 'authorization' && normalized !== 'idempotency-key') result[key] = value
  }
  return result
}

const tracedTokenManagers = new WeakSet<HostedTokenManager>()

/**
 * Adds the token-refresh phase line without changing credential behaviour.
 * `network=yes` means the refresh attempt reached the wire (the traced global
 * fetch counted a request); `network=no` means the stored credential was
 * reused or the store refused locally. No token material is ever printed.
 * Exported for the trace test; production callers reach it through the client
 * constructor.
 */
export function traceTokenRefresh(tokens: HostedTokenManager, tracer: Tracer = trace): void {
  if (!tracer.enabled || tracedTokenManagers.has(tokens)) return
  tracedTokenManagers.add(tokens)
  const refresh = tokens.refresh.bind(tokens)
  tokens.refresh = (request) => {
    const started = performance.now()
    const requestsBefore = tracer.httpRequestCount
    return refresh(request).finally(() => {
      tracer.phase('token-refresh', {
        durationMs: performance.now() - started,
        network: tracer.httpRequestCount > requestsBefore ? 'yes' : 'no',
      })
    })
  }
}

/**
 * Handwritten boundary over the generated `/v1` client. It owns protocol,
 * client, and request headers, timeouts, and redacted diagnostics; the
 * generated file is never hand-edited and no private code is imported.
 */
export class OcboxApiClient {
  readonly #client: OpenCloudBoxClient
  readonly #protocol: HostedProtocolEndpoints
  readonly #transport: ApiTransport

  constructor(options: OcboxApiClientOptions) {
    traceTokenRefresh(options.tokens)
    const headers = withoutManagedHeaders(options.headers)
    const transport = createAuthenticatedTransport(options.tokens, {
      apiOrigin: options.protocol.issuer,
      fetch: options.fetch,
      maxResponseBytes: options.maxResponseBytes,
      timeoutMilliseconds: options.timeoutMilliseconds ?? DEFAULT_HTTP_TIMEOUT_MILLISECONDS,
    })
    this.#protocol = options.protocol
    this.#transport = transport
    this.#client = createClient(options.protocol.issuer, {
      transport,
      headers: {
        accept: 'application/json',
        'user-agent': OCBOX_CLI_USER_AGENT,
        ...(headers ?? {}),
      },
    })
  }

  get generated(): OpenCloudBoxClient {
    return this.#client
  }

  /**
   * Reads the box sizes the caller's plan offers. The pinned generated client
   * predates this route, so it is requested here through the same
   * authenticated transport and the same failure mapping as every other call.
   */
  async listSizes(signal?: AbortSignal): Promise<ApiResult<unknown>> {
    const base = this.#protocol.issuer.replace(/\/v1\/?$/, '').replace(/\/$/, '')
    const response = await this.#transport.fetch(new URL(`${base}/v1/sizes`), {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': OCBOX_CLI_USER_AGENT },
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await response.text()
    let body: unknown = null
    try {
      body = text.length === 0 ? null : JSON.parse(text)
    } catch {
      // A body that is not JSON is judged by its status alone; never echoed.
    }
    return {
      body,
      replay: false,
      requestId: response.headers.get('x-request-id'),
      status: response.status,
    }
  }

  /**
   * Reads whether a GPU box can be created right now. Like `listSizes`, the
   * pinned generated client predates this route, so it travels through the same
   * authenticated transport and the same failure mapping as every other call.
   */
  async checkGpuSpec(query: GpuCheckQuery, signal?: AbortSignal): Promise<ApiResult<unknown>> {
    const base = this.#protocol.issuer.replace(/\/v1\/?$/, '').replace(/\/$/, '')
    const url = new URL(`${base}/v1/gpu-check`)
    url.searchParams.set('gpuType', query.gpuType)
    url.searchParams.set('gpuCount', String(query.gpuCount))
    if (query.lifetimeSeconds !== undefined)
      url.searchParams.set('lifetimeSeconds', String(query.lifetimeSeconds))
    if (query.cpu !== undefined) url.searchParams.set('cpu', String(query.cpu))
    if (query.memoryMib !== undefined) url.searchParams.set('memoryMib', String(query.memoryMib))
    if (query.diskGib !== undefined) url.searchParams.set('diskGib', String(query.diskGib))
    const response = await this.#transport.fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': OCBOX_CLI_USER_AGENT },
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await response.text()
    let body: unknown = null
    try {
      body = text.length === 0 ? null : JSON.parse(text)
    } catch {
      // A body that is not JSON is judged by its status alone; never echoed.
    }
    return {
      body,
      replay: false,
      requestId: response.headers.get('x-request-id'),
      status: response.status,
    }
  }

  /**
   * Lists one project's Sessions. The pinned generated client predates the
   * `includeDestroyed` query parameter, so this route is requested through the
   * same authenticated transport and failure mapping as `listSizes`.
   */
  async listProjectSessions(
    query: SessionListQuery,
    signal?: AbortSignal,
  ): Promise<ApiResult<unknown>> {
    const base = this.#protocol.issuer.replace(/\/v1\/?$/, '').replace(/\/$/, '')
    const url = new URL(`${base}/v1/projects/${encodeURIComponent(query.projectId)}/sessions`)
    if (query.cursor !== undefined) url.searchParams.set('cursor', query.cursor)
    if (query.limit !== undefined) url.searchParams.set('limit', String(query.limit))
    if (query.includeDestroyed !== undefined)
      url.searchParams.set('includeDestroyed', String(query.includeDestroyed))
    const response = await this.#transport.fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': OCBOX_CLI_USER_AGENT },
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await response.text()
    let body: unknown = null
    try {
      body = text.length === 0 ? null : JSON.parse(text)
    } catch {
      // A body that is not JSON is judged by its status alone; never echoed.
    }
    return {
      body,
      replay: false,
      requestId: response.headers.get('x-request-id'),
      status: response.status,
    }
  }

  /**
   * Captures a snapshot of one Session. The pinned generated client predates
   * this route, so it is requested through the same authenticated transport and
   * the same failure mapping as `listSizes`.
   */
  async createSnapshot(
    sessionId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<unknown>> {
    const base = this.#protocol.issuer.replace(/\/v1\/?$/, '').replace(/\/$/, '')
    const url = new URL(`${base}/v1/sessions/${encodeURIComponent(sessionId)}/snapshots`)
    const response = await this.#transport.fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'user-agent': OCBOX_CLI_USER_AGENT,
        'idempotency-key': idempotencyKey,
      },
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await response.text()
    let body: unknown = null
    try {
      body = text.length === 0 ? null : JSON.parse(text)
    } catch {
      // A body that is not JSON is judged by its status alone; never echoed.
    }
    return {
      body,
      replay: false,
      requestId: response.headers.get('x-request-id'),
      status: response.status,
    }
  }

  /**
   * Lists the snapshots of one Session. The pinned generated client predates
   * this route, so it is requested through the same authenticated transport and
   * the same failure mapping as `listSizes`.
   */
  async listSnapshots(sessionId: string, signal?: AbortSignal): Promise<ApiResult<unknown>> {
    const base = this.#protocol.issuer.replace(/\/v1\/?$/, '').replace(/\/$/, '')
    const url = new URL(`${base}/v1/sessions/${encodeURIComponent(sessionId)}/snapshots`)
    const response = await this.#transport.fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': OCBOX_CLI_USER_AGENT },
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await response.text()
    let body: unknown = null
    try {
      body = text.length === 0 ? null : JSON.parse(text)
    } catch {
      // A body that is not JSON is judged by its status alone; never echoed.
    }
    return {
      body,
      replay: false,
      requestId: response.headers.get('x-request-id'),
      status: response.status,
    }
  }

  /**
   * Restores one Session snapshot. The pinned generated client predates this
   * route, so it is requested through the same authenticated transport and the
   * same failure mapping as `listSizes`.
   */
  async restoreSnapshot(
    sessionId: string,
    snapshotId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<unknown>> {
    const base = this.#protocol.issuer.replace(/\/v1\/?$/, '').replace(/\/$/, '')
    const url = new URL(
      `${base}/v1/sessions/${encodeURIComponent(sessionId)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
    )
    const response = await this.#transport.fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'user-agent': OCBOX_CLI_USER_AGENT,
        'idempotency-key': idempotencyKey,
      },
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await response.text()
    let body: unknown = null
    try {
      body = text.length === 0 ? null : JSON.parse(text)
    } catch {
      // A body that is not JSON is judged by its status alone; never echoed.
    }
    return {
      body,
      replay: false,
      requestId: response.headers.get('x-request-id'),
      status: response.status,
    }
  }

  /**
   * Deletes one Session snapshot. The pinned generated client predates this
   * route, so it is requested through the same authenticated transport and the
   * same failure mapping as `listSizes`.
   */
  async deleteSnapshot(
    sessionId: string,
    snapshotId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<unknown>> {
    const base = this.#protocol.issuer.replace(/\/v1\/?$/, '').replace(/\/$/, '')
    const url = new URL(
      `${base}/v1/sessions/${encodeURIComponent(sessionId)}/snapshots/${encodeURIComponent(snapshotId)}`,
    )
    const response = await this.#transport.fetch(url, {
      method: 'DELETE',
      headers: {
        accept: 'application/json',
        'user-agent': OCBOX_CLI_USER_AGENT,
        'idempotency-key': idempotencyKey,
      },
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await response.text()
    let body: unknown = null
    try {
      body = text.length === 0 ? null : JSON.parse(text)
    } catch {
      // A body that is not JSON is judged by its status alone; never echoed.
    }
    return {
      body,
      replay: false,
      requestId: response.headers.get('x-request-id'),
      status: response.status,
    }
  }

  get issuer(): string {
    return this.#protocol.issuer
  }

  /**
   * Throws the mapped stable error when the status is not an expected
   * success code. Success bodies pass through untouched with their
   * request-ID/replay metadata.
   */
  assertSuccess<ResponseType>(
    operation: string,
    result: ApiResult<ResponseType>,
    expected: readonly number[],
  ): { body: Exclude<ResponseType, { error: unknown }>; meta: ApiCallMetadata } {
    const meta: ApiCallMetadata = {
      operation,
      replay: result.replay,
      requestId: result.requestId,
      status: result.status,
    }
    if (expected.includes(result.status)) {
      return { body: result.body as Exclude<ResponseType, { error: unknown }>, meta }
    }
    const envelope = envelopeOf(result.body)
    throw mapApiFailureToOcboxError({
      operation,
      requestId: result.requestId ?? envelope.requestId ?? null,
      responseRequestId: envelope.requestId ?? result.requestId ?? null,
      retryAfterSeconds: envelope.retryAfterSeconds ?? null,
      serverCode: envelope.code,
      serverMessage: envelope.message,
      reason: envelope.reason,
      reasonCode: envelope.reasonCode,
      nextStep: envelope.nextStep,
      limitName: envelope.limitName,
      limitValue: envelope.limitValue,
      status: result.status,
    })
  }

  /** Renders a redacted one-line diagnostic with no headers, body, or token. */
  describe(operation: string, status: number, requestId: string | null): string {
    return `${operation} status=${status} requestId=${requestId ?? newRequestId()}`
  }
}

export function createOcboxApiClient(options: OcboxApiClientOptions): OcboxApiClient {
  return new OcboxApiClient(options)
}

/** Asserts an OcboxError carries no credential-like material for test gates. */
export function assertErrorRedacted(error: OcboxError): void {
  const haystacks = [error.message, error.providerCode ?? '', JSON.stringify(error.details ?? {})]
  for (const haystack of haystacks) {
    if (
      /Bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}/i.test(haystack)
    ) {
      throw new Error('Error diagnostic leaks credential-like material')
    }
  }
}

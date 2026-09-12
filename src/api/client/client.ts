import { createClient, type ApiResult, type OpenCloudBoxClient } from '../generated/client.js'
import { createAuthenticatedTransport } from '../../auth/hosted-client.js'
import {
  DEFAULT_HTTP_TIMEOUT_MILLISECONDS,
  type HostedProtocolEndpoints,
} from '../../auth/config.js'
import type { FetchPort } from '../../auth/ports.js'
import type { HostedTokenManager } from '../../auth/token-manager.js'
import type { OcboxError } from '../../errors/index.js'
import { newRequestId } from '../../auth/errors.js'
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

/**
 * Handwritten boundary over the generated `/v1` client. It owns protocol,
 * client, and request headers, timeouts, and redacted diagnostics; the
 * generated file is never hand-edited and no private code is imported.
 */
export class OcboxApiClient {
  readonly #client: OpenCloudBoxClient
  readonly #protocol: HostedProtocolEndpoints

  constructor(options: OcboxApiClientOptions) {
    const headers = withoutManagedHeaders(options.headers)
    const transport = createAuthenticatedTransport(options.tokens, {
      apiOrigin: options.protocol.issuer,
      fetch: options.fetch,
      maxResponseBytes: options.maxResponseBytes,
      timeoutMilliseconds: options.timeoutMilliseconds ?? DEFAULT_HTTP_TIMEOUT_MILLISECONDS,
    })
    this.#protocol = options.protocol
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
      serverCode: envelope.code,
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

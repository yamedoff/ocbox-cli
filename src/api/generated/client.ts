/**
 * Generated from openapi/openapi.yaml. DO NOT EDIT BY HAND.
 *
 * Pinned source commit: 96ea22927492a16d115daa791a3836ac9e06d159
 * Pinned source SHA-256: 605be009a98ae9207efa44be343bffc7e28435b76259a81f4239b458ca3396ca
 * Regenerate with: pnpm run api:generate
 *
 * This file depends only on the standard Web Fetch surface provided by the
 * Node runtime. It never imports private implementation or domain code.
 */

export const OPENAPI_SOURCE_COMMIT = "96ea22927492a16d115daa791a3836ac9e06d159" as const
export const OPENAPI_CHECKSUM = "sha256:605be009a98ae9207efa44be343bffc7e28435b76259a81f4239b458ca3396ca" as const

export interface ApiTransport {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
}

export interface ReadRequestOptions {
  readonly signal?: AbortSignal
}

export interface MutatingRequestOptions {
  readonly idempotencyKey: string
  readonly signal?: AbortSignal
}

export interface ApiResult<ResponseType> {
  readonly status: number
  readonly body: ResponseType
  readonly requestId: string | null
  readonly replay: boolean
}

export interface SafeError {
  readonly code: string
  readonly message: string
  readonly retryAfterSeconds?: number
}

export interface User {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface Profile {
  readonly id: string
  readonly userId: string
  readonly displayName: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface Sandbox {
  readonly id: string
  readonly projectId: string
  readonly normalizedState: "creating" | "deleting" | "deleted" | "error" | "paused" | "pausing" | "running" | "stopping" | "stopped" | "unknown"
  readonly rawState: string
  readonly providerKind: string
  readonly reconciliationStatus: "error" | "fresh" | "pending" | "stale"
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SecretReference {
  readonly id: string
  readonly projectId: string
  readonly environmentId: string
  readonly name: string
  readonly provider: string
  readonly exposureMode: "process" | "host"
  readonly allowedHosts: readonly string[]
  readonly status: "active" | "delete_pending" | "deleted"
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SandboxBinding {
  readonly ordinal: number
  readonly role: "primary"
  readonly active: boolean
  readonly state: "running" | "stopped"
  readonly sandboxId: string
  readonly boundAt: string
  readonly releasedAt: string | null
}

export interface Project {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly name: string
}

export interface Environment {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly projectId: string
  readonly name: string
  readonly selected: boolean
}

export interface Session {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly projectId: string
  readonly requestedSpec: Record<string, unknown>
  readonly effectiveSpec: Record<string, unknown>
  readonly normalizedState: "created" | "starting" | "running" | "pausing" | "paused" | "stopping" | "stopped" | "destroying" | "destroyed"
  readonly rawState: string
  readonly sandboxes: readonly SandboxBinding[]
  readonly primarySandboxId: string | null
}

export interface ResourceLink {
  readonly type: "project" | "environment" | "session" | "execution" | "sourceManifest" | "preview"
  readonly id: string
}

export interface Operation {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly kind: string
  readonly projectId: string | null
  readonly sessionId: string | null
  readonly state: "pending" | "running" | "succeeded" | "cancelled" | "failed"
  readonly progress: number
  readonly requestId: string
  readonly error: SafeError | null
  readonly resource: ResourceLink | null
}

export interface Execution {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly sessionId: string
  readonly sandboxId: string | null
  readonly state: "pending" | "running" | "completed" | "cancelled" | "failed"
  readonly command: string
  readonly exitCode: number | null
  readonly failureKind: "command" | "infrastructure" | null
  readonly failure: SafeError | null
  readonly truncated: boolean
  readonly outputBytes: number
  readonly outputLimitBytes: number
}

export interface ExecutionEvent {
  readonly sequence: number
  readonly at: string
  readonly kind: "started" | "stdout" | "stderr" | "progress" | "completed" | "failed" | "cancelled"
  readonly stream: "stdout" | "stderr" | null
  readonly message: string
}

export interface CommandResult {
  readonly kind: "command"
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly outputBytes: number
  readonly outputLimitBytes: number
}

export interface InfrastructureResult {
  readonly kind: "infrastructure"
  readonly error: SafeError
}

export interface CancelledResult {
  readonly kind: "cancelled"
}

export type ExecutionResult = CommandResult | InfrastructureResult | CancelledResult

export interface SourceManifest {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly sessionId: string
  readonly checksum: string
  readonly chunkCount: number
  readonly totalBytes: number
  readonly uploadedChunks: number
  readonly verified: boolean
}

export interface ChunkReceipt {
  readonly manifestId: string
  readonly chunkIndex: number
  readonly chunkChecksum: string
  readonly receivedBytes: number
  readonly uploadedChunks: number
}

export interface SourceVerification {
  readonly manifestId: string
  readonly checksum: string
  readonly chunkCount: number
  readonly verified: boolean
}

export interface Preview {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly sessionId: string
  readonly state: "active" | "deleted"
  readonly url: string
  readonly port: number
  readonly expiresAt: string
}

export interface ProjectPage {
  readonly data: readonly Project[]
  readonly nextCursor: string | null
}

export interface EnvironmentPage {
  readonly data: readonly Environment[]
  readonly nextCursor: string | null
}

export interface SessionPage {
  readonly data: readonly Session[]
  readonly nextCursor: string | null
}

export interface OperationPage {
  readonly data: readonly Operation[]
  readonly nextCursor: string | null
}

export interface ExecutionEventPage {
  readonly data: readonly ExecutionEvent[]
  readonly nextCursor: string | null
}

export interface SourceManifestPage {
  readonly data: readonly SourceManifest[]
  readonly nextCursor: string | null
}

export interface CreateProjectRequest {
  readonly name: string
}

export interface UpdateProjectRequest {
  readonly name: string
}

export interface CreateEnvironmentRequest {
  readonly name: string
}

export interface UpdateEnvironmentRequest {
  readonly name?: string
  readonly selected?: boolean
}

export interface CreateSessionRequest {
  readonly requestedSpec?: Record<string, unknown>
}

export interface CreateExecutionRequest {
  readonly command: string
  readonly timeoutSeconds?: number
}

export interface CreateSourceManifestRequest {
  readonly checksum: string
  readonly chunkCount: number
  readonly totalBytes: number
}

export interface UploadSourceChunkRequest {
  readonly data: string
  readonly checksum: string
}

export interface CreatePreviewRequest {
  readonly port: number
  readonly ttlSeconds?: number
}

export interface RequestMagicLinkRequest {
  readonly email: string
}

export interface MagicLinkAccepted {
  readonly accepted: boolean
}

export interface ConsumeMagicLinkRequest {
  readonly token: string
}

export interface StartGithubLoginRequest {
  readonly redirectTo: string
}

export interface GithubLoginStart {
  readonly authorizationUrl: string
  readonly state: string
}

export interface CompleteGithubLoginRequest {
  readonly state: string
  readonly providerCode: string
}

export interface WebSession {
  readonly id: string
  readonly userId: string
  readonly authMethod: "github" | "magic_link"
  readonly createdAt: string
  readonly expiresAt: string
}

export interface WebSessionIssued {
  readonly session: WebSession
  readonly csrfToken: string
}

export interface StartCliAuthorizationRequest {
  readonly clientId: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly codeChallengeMethod: "S256"
  readonly audience: "cli" | "mcp"
  readonly scope: string
  readonly state: string
  readonly consent?: { readonly consentId: string; readonly approve: boolean }
}

export type CliAuthorizationStart = { readonly status: "consent_required"; readonly consentId: string; readonly clientId: string; readonly audience: "cli" | "mcp"; readonly scopes: readonly string[] } | { readonly status: "authorized"; readonly redirectUri: string; readonly expiresAt: string }

export interface CliTokenRequest {
  readonly clientId: string
  readonly grantType: "authorization_code" | "refresh_token"
  readonly code?: string
  readonly redirectUri?: string
  readonly codeVerifier?: string
  readonly refreshToken?: string
}

export interface CliTokenPair {
  readonly accessToken: string
  readonly tokenType: "Bearer"
  readonly expiresIn: number
  readonly scope: string
  readonly refreshToken: string
}

export interface RevokeTokenRequest {
  readonly clientId?: string
  readonly token: string
}

export interface GithubInstallation {
  readonly id: string
  readonly accountLogin: string
  readonly status: "active" | "suspended" | "uninstalled"
  readonly repositorySelection: "all" | "selected"
  readonly createdAt: string
  readonly updatedAt: string
  readonly permissions: { readonly contents: "read"; readonly metadata: "read" }
  readonly selectedRepositories: readonly GithubRepository[]
}

export interface GithubRepository {
  readonly ownerLogin: string
  readonly name: string
}

export interface GithubInstallationPage {
  readonly data: readonly GithubInstallation[]
  readonly nextCursor: string | null
}

export interface ResolveGithubSourceRequest {
  readonly repositoryOwner: string
  readonly repositoryName: string
  readonly ref: string
}

export interface GithubSourceResolution {
  readonly resolutionId: string
  readonly cloneUrl: string
  readonly commitSha: string
  readonly ref: string
  readonly resolvedAt: string
}

export interface ErrorEnvelope {
  readonly error: SafeError
  readonly requestId: string
}

export interface OpenCloudBoxClient {
  listProjects(args?: { readonly query?: { readonly cursor?: string; readonly limit?: number }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  createProject(args: { readonly body: CreateProjectRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  getProject(args: { readonly path: { readonly projectId: string }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  updateProject(args: { readonly path: { readonly projectId: string }; readonly body: UpdateProjectRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  deleteProject(args: { readonly path: { readonly projectId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  listEnvironments(args: { readonly path: { readonly projectId: string }; readonly query?: { readonly cursor?: string; readonly limit?: number }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  createEnvironment(args: { readonly path: { readonly projectId: string }; readonly body: CreateEnvironmentRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  getEnvironment(args: { readonly path: { readonly environmentId: string }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  updateEnvironment(args: { readonly path: { readonly environmentId: string }; readonly body: UpdateEnvironmentRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  deleteEnvironment(args: { readonly path: { readonly environmentId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  listSessions(args: { readonly path: { readonly projectId: string }; readonly query?: { readonly cursor?: string; readonly limit?: number }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  createSession(args: { readonly path: { readonly projectId: string }; readonly body: CreateSessionRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  getSession(args: { readonly path: { readonly sessionId: string }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  startSession(args: { readonly path: { readonly sessionId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  pauseSession(args: { readonly path: { readonly sessionId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  stopSession(args: { readonly path: { readonly sessionId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  destroySession(args: { readonly path: { readonly sessionId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  listOperations(args?: { readonly query?: { readonly cursor?: string; readonly limit?: number }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  getOperation(args: { readonly path: { readonly operationId: string }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  cancelOperation(args: { readonly path: { readonly operationId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  createExecution(args: { readonly path: { readonly sessionId: string }; readonly body: CreateExecutionRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  getExecution(args: { readonly path: { readonly executionId: string }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  listExecutionEvents(args: { readonly path: { readonly executionId: string }; readonly query?: { readonly cursor?: string; readonly limit?: number }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  getExecutionResult(args: { readonly path: { readonly executionId: string }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  cancelExecution(args: { readonly path: { readonly executionId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  listSourceManifests(args: { readonly path: { readonly sessionId: string }; readonly query?: { readonly cursor?: string; readonly limit?: number }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  createSourceManifest(args: { readonly path: { readonly sessionId: string }; readonly body: CreateSourceManifestRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  uploadSourceChunk(args: { readonly path: { readonly manifestId: string; readonly chunkIndex: number }; readonly body: UploadSourceChunkRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  verifySourceChecksum(args: { readonly path: { readonly manifestId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  createPreview(args: { readonly path: { readonly sessionId: string }; readonly body: CreatePreviewRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  deletePreview(args: { readonly path: { readonly previewId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  requestMagicLink(args: { readonly body: RequestMagicLinkRequest; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  consumeMagicLink(args: { readonly body: ConsumeMagicLinkRequest; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  startGithubWebLogin(args: { readonly body: StartGithubLoginRequest; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  completeGithubWebLogin(args: { readonly body: CompleteGithubLoginRequest; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  getCurrentWebSession(args?: { readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  revokeCurrentWebSession(args?: { readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  renewWebSession(args?: { readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  startCliAuthorization(args: { readonly body: StartCliAuthorizationRequest; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  exchangeCliToken(args: { readonly body: CliTokenRequest; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  revokeCliToken(args: { readonly body: RevokeTokenRequest; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  listGithubInstallations(args?: { readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  getGithubInstallation(args: { readonly path: { readonly installationId: string }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
  resolveGithubSource(args: { readonly path: { readonly installationId: string }; readonly body: ResolveGithubSourceRequest; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>>
}

export interface ClientOptions {
  readonly transport?: ApiTransport
  readonly headers?: Readonly<Record<string, string>>
}

export function createClient(baseUrl: string, options: ClientOptions = {}): OpenCloudBoxClient {
  const transport = options.transport ?? (globalThis as unknown as ApiTransport)
  const defaultHeaders = options.headers ?? {}
  const normalizedBase = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '')
  return {
    async listProjects(args?: { readonly query?: { readonly cursor?: string; readonly limit?: number }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/projects`)
      if (args?.query !== undefined) {
        if (args.query.cursor !== undefined) url.searchParams.set("cursor", String(args.query.cursor))
        if (args.query.limit !== undefined) url.searchParams.set("limit", String(args.query.limit))
      }
      const headers: Record<string, string> = { ...defaultHeaders }
      const response = await transport.fetch(url, {
        method: "GET",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async createProject(args: { readonly body: CreateProjectRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/projects`)
      const headers: Record<string, string> = { ...defaultHeaders }
      if (args?.body !== undefined) headers['content-type'] = 'application/json'
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async getProject(args: { readonly path: { readonly projectId: string }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/projects/${encodeURIComponent(String(args.path.projectId))}`)
      const headers: Record<string, string> = { ...defaultHeaders }
      const response = await transport.fetch(url, {
        method: "GET",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async updateProject(args: { readonly path: { readonly projectId: string }; readonly body: UpdateProjectRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/projects/${encodeURIComponent(String(args.path.projectId))}`)
      const headers: Record<string, string> = { ...defaultHeaders }
      if (args?.body !== undefined) headers['content-type'] = 'application/json'
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "PATCH",
        headers,
        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async deleteProject(args: { readonly path: { readonly projectId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/projects/${encodeURIComponent(String(args.path.projectId))}`)
      const headers: Record<string, string> = { ...defaultHeaders }
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "DELETE",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async listEnvironments(args: { readonly path: { readonly projectId: string }; readonly query?: { readonly cursor?: string; readonly limit?: number }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/projects/${encodeURIComponent(String(args.path.projectId))}/environments`)
      if (args?.query !== undefined) {
        if (args.query.cursor !== undefined) url.searchParams.set("cursor", String(args.query.cursor))
        if (args.query.limit !== undefined) url.searchParams.set("limit", String(args.query.limit))
      }
      const headers: Record<string, string> = { ...defaultHeaders }
      const response = await transport.fetch(url, {
        method: "GET",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async createEnvironment(args: { readonly path: { readonly projectId: string }; readonly body: CreateEnvironmentRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/projects/${encodeURIComponent(String(args.path.projectId))}/environments`)
      const headers: Record<string, string> = { ...defaultHeaders }
      if (args?.body !== undefined) headers['content-type'] = 'application/json'
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async getEnvironment(args: { readonly path: { readonly environmentId: string }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/environments/${encodeURIComponent(String(args.path.environmentId))}`)
      const headers: Record<string, string> = { ...defaultHeaders }
      const response = await transport.fetch(url, {
        method: "GET",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async updateEnvironment(args: { readonly path: { readonly environmentId: string }; readonly body: UpdateEnvironmentRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/environments/${encodeURIComponent(String(args.path.environmentId))}`)
      const headers: Record<string, string> = { ...defaultHeaders }
      if (args?.body !== undefined) headers['content-type'] = 'application/json'
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "PATCH",
        headers,
        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async deleteEnvironment(args: { readonly path: { readonly environmentId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/environments/${encodeURIComponent(String(args.path.environmentId))}`)
      const headers: Record<string, string> = { ...defaultHeaders }
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "DELETE",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async listSessions(args: { readonly path: { readonly projectId: string }; readonly query?: { readonly cursor?: string; readonly limit?: number }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/projects/${encodeURIComponent(String(args.path.projectId))}/sessions`)
      if (args?.query !== undefined) {
        if (args.query.cursor !== undefined) url.searchParams.set("cursor", String(args.query.cursor))
        if (args.query.limit !== undefined) url.searchParams.set("limit", String(args.query.limit))
      }
      const headers: Record<string, string> = { ...defaultHeaders }
      const response = await transport.fetch(url, {
        method: "GET",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async createSession(args: { readonly path: { readonly projectId: string }; readonly body: CreateSessionRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/projects/${encodeURIComponent(String(args.path.projectId))}/sessions`)
      const headers: Record<string, string> = { ...defaultHeaders }
      if (args?.body !== undefined) headers['content-type'] = 'application/json'
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async getSession(args: { readonly path: { readonly sessionId: string }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/sessions/${encodeURIComponent(String(args.path.sessionId))}`)
      const headers: Record<string, string> = { ...defaultHeaders }
      const response = await transport.fetch(url, {
        method: "GET",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async startSession(args: { readonly path: { readonly sessionId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/sessions/${encodeURIComponent(String(args.path.sessionId))}/start`)
      const headers: Record<string, string> = { ...defaultHeaders }
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async pauseSession(args: { readonly path: { readonly sessionId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/sessions/${encodeURIComponent(String(args.path.sessionId))}/pause`)
      const headers: Record<string, string> = { ...defaultHeaders }
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async stopSession(args: { readonly path: { readonly sessionId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/sessions/${encodeURIComponent(String(args.path.sessionId))}/stop`)
      const headers: Record<string, string> = { ...defaultHeaders }
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async destroySession(args: { readonly path: { readonly sessionId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/sessions/${encodeURIComponent(String(args.path.sessionId))}/destroy`)
      const headers: Record<string, string> = { ...defaultHeaders }
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async listOperations(args?: { readonly query?: { readonly cursor?: string; readonly limit?: number }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/operations`)
      if (args?.query !== undefined) {
        if (args.query.cursor !== undefined) url.searchParams.set("cursor", String(args.query.cursor))
        if (args.query.limit !== undefined) url.searchParams.set("limit", String(args.query.limit))
      }
      const headers: Record<string, string> = { ...defaultHeaders }
      const response = await transport.fetch(url, {
        method: "GET",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async getOperation(args: { readonly path: { readonly operationId: string }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/operations/${encodeURIComponent(String(args.path.operationId))}`)
      const headers: Record<string, string> = { ...defaultHeaders }
      const response = await transport.fetch(url, {
        method: "GET",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async cancelOperation(args: { readonly path: { readonly operationId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/operations/${encodeURIComponent(String(args.path.operationId))}/cancel`)
      const headers: Record<string, string> = { ...defaultHeaders }
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async createExecution(args: { readonly path: { readonly sessionId: string }; readonly body: CreateExecutionRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/sessions/${encodeURIComponent(String(args.path.sessionId))}/executions`)
      const headers: Record<string, string> = { ...defaultHeaders }
      if (args?.body !== undefined) headers['content-type'] = 'application/json'
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async getExecution(args: { readonly path: { readonly executionId: string }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/executions/${encodeURIComponent(String(args.path.executionId))}`)
      const headers: Record<string, string> = { ...defaultHeaders }
      const response = await transport.fetch(url, {
        method: "GET",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async listExecutionEvents(args: { readonly path: { readonly executionId: string }; readonly query?: { readonly cursor?: string; readonly limit?: number }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/executions/${encodeURIComponent(String(args.path.executionId))}/events`)
      if (args?.query !== undefined) {
        if (args.query.cursor !== undefined) url.searchParams.set("cursor", String(args.query.cursor))
        if (args.query.limit !== undefined) url.searchParams.set("limit", String(args.query.limit))
      }
      const headers: Record<string, string> = { ...defaultHeaders }
      const response = await transport.fetch(url, {
        method: "GET",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async getExecutionResult(args: { readonly path: { readonly executionId: string }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/executions/${encodeURIComponent(String(args.path.executionId))}/result`)
      const headers: Record<string, string> = { ...defaultHeaders }
      const response = await transport.fetch(url, {
        method: "GET",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async cancelExecution(args: { readonly path: { readonly executionId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/executions/${encodeURIComponent(String(args.path.executionId))}/cancel`)
      const headers: Record<string, string> = { ...defaultHeaders }
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async listSourceManifests(args: { readonly path: { readonly sessionId: string }; readonly query?: { readonly cursor?: string; readonly limit?: number }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/sessions/${encodeURIComponent(String(args.path.sessionId))}/source/manifests`)
      if (args?.query !== undefined) {
        if (args.query.cursor !== undefined) url.searchParams.set("cursor", String(args.query.cursor))
        if (args.query.limit !== undefined) url.searchParams.set("limit", String(args.query.limit))
      }
      const headers: Record<string, string> = { ...defaultHeaders }
      const response = await transport.fetch(url, {
        method: "GET",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async createSourceManifest(args: { readonly path: { readonly sessionId: string }; readonly body: CreateSourceManifestRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/sessions/${encodeURIComponent(String(args.path.sessionId))}/source/manifests`)
      const headers: Record<string, string> = { ...defaultHeaders }
      if (args?.body !== undefined) headers['content-type'] = 'application/json'
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async uploadSourceChunk(args: { readonly path: { readonly manifestId: string; readonly chunkIndex: number }; readonly body: UploadSourceChunkRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/source/manifests/${encodeURIComponent(String(args.path.manifestId))}/chunks/${encodeURIComponent(String(args.path.chunkIndex))}`)
      const headers: Record<string, string> = { ...defaultHeaders }
      if (args?.body !== undefined) headers['content-type'] = 'application/json'
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "PUT",
        headers,
        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async verifySourceChecksum(args: { readonly path: { readonly manifestId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/source/manifests/${encodeURIComponent(String(args.path.manifestId))}/checksum`)
      const headers: Record<string, string> = { ...defaultHeaders }
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async createPreview(args: { readonly path: { readonly sessionId: string }; readonly body: CreatePreviewRequest; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/sessions/${encodeURIComponent(String(args.path.sessionId))}/previews`)
      const headers: Record<string, string> = { ...defaultHeaders }
      if (args?.body !== undefined) headers['content-type'] = 'application/json'
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async deletePreview(args: { readonly path: { readonly previewId: string }; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/previews/${encodeURIComponent(String(args.path.previewId))}`)
      const headers: Record<string, string> = { ...defaultHeaders }
      headers['idempotency-key'] = args.idempotencyKey
      const response = await transport.fetch(url, {
        method: "DELETE",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async requestMagicLink(args: { readonly body: RequestMagicLinkRequest; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/auth/magic-links`)
      const headers: Record<string, string> = { ...defaultHeaders }
      if (args?.body !== undefined) headers['content-type'] = 'application/json'
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async consumeMagicLink(args: { readonly body: ConsumeMagicLinkRequest; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/auth/magic-links/consume`)
      const headers: Record<string, string> = { ...defaultHeaders }
      if (args?.body !== undefined) headers['content-type'] = 'application/json'
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async startGithubWebLogin(args: { readonly body: StartGithubLoginRequest; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/auth/github/start`)
      const headers: Record<string, string> = { ...defaultHeaders }
      if (args?.body !== undefined) headers['content-type'] = 'application/json'
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async completeGithubWebLogin(args: { readonly body: CompleteGithubLoginRequest; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/auth/github/callback`)
      const headers: Record<string, string> = { ...defaultHeaders }
      if (args?.body !== undefined) headers['content-type'] = 'application/json'
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async getCurrentWebSession(args?: { readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/auth/sessions/current`)
      const headers: Record<string, string> = { ...defaultHeaders }
      const response = await transport.fetch(url, {
        method: "GET",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async revokeCurrentWebSession(args?: { readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/auth/sessions/current`)
      const headers: Record<string, string> = { ...defaultHeaders }
      const response = await transport.fetch(url, {
        method: "DELETE",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async renewWebSession(args?: { readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/auth/sessions/current/renew`)
      const headers: Record<string, string> = { ...defaultHeaders }
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async startCliAuthorization(args: { readonly body: StartCliAuthorizationRequest; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/auth/cli/authorize`)
      const headers: Record<string, string> = { ...defaultHeaders }
      if (args?.body !== undefined) headers['content-type'] = 'application/json'
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async exchangeCliToken(args: { readonly body: CliTokenRequest; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/auth/cli/token`)
      const headers: Record<string, string> = { ...defaultHeaders }
      if (args?.body !== undefined) headers['content-type'] = 'application/json'
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async revokeCliToken(args: { readonly body: RevokeTokenRequest; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/auth/revoke`)
      const headers: Record<string, string> = { ...defaultHeaders }
      if (args?.body !== undefined) headers['content-type'] = 'application/json'
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async listGithubInstallations(args?: { readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/github/installations`)
      const headers: Record<string, string> = { ...defaultHeaders }
      const response = await transport.fetch(url, {
        method: "GET",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async getGithubInstallation(args: { readonly path: { readonly installationId: string }; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/github/installations/${encodeURIComponent(String(args.path.installationId))}`)
      const headers: Record<string, string> = { ...defaultHeaders }
      const response = await transport.fetch(url, {
        method: "GET",
        headers,
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
    async resolveGithubSource(args: { readonly path: { readonly installationId: string }; readonly body: ResolveGithubSourceRequest; readonly signal?: AbortSignal }): Promise<ApiResult<unknown>> {
      const url = new URL(`${normalizedBase}/v1/github/installations/${encodeURIComponent(String(args.path.installationId))}/source`)
      const headers: Record<string, string> = { ...defaultHeaders }
      if (args?.body !== undefined) headers['content-type'] = 'application/json'
      const response = await transport.fetch(url, {
        method: "POST",
        headers,
        ...(args?.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        ...(args?.signal === undefined ? {} : { signal: args.signal }),
      })
      const text = await response.text()
      const parsed: unknown = text.length === 0 ? null : JSON.parse(text)
      return {
        body: parsed as unknown,
        requestId: response.headers.get('x-request-id'),
        replay: response.headers.get('idempotency-replayed') === 'true',
        status: response.status,
      }
    },
  }
}

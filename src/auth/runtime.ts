import { join } from 'node:path'
import type { RuntimeFlags } from '../cli/runtime.js'
import { resolveStateDirectory } from '../cli/runtime.js'
import {
  type CredentialStore,
  type HostedOAuthCredential,
  type HostedOAuthCredentialKey,
  HostedOAuthCredentialStore,
  type OsCredentialAdapter,
  ProtectedFileCredentialStore,
} from '../credentials/index.js'
import { OcboxError } from '../errors/index.js'
import {
  AtomicStoreCancelledError,
  AtomicStoreConflictError,
} from '../lifecycle/atomic-json-store.js'
import { ExclusiveFileLock } from '../state/exclusive-file-lock.js'
import { resolveCurrentPlatformPaths } from '../platform/index.js'
import { AuthenticatedHttpClient } from './authenticated-client.js'
import { PlatformBrowserOpener } from './browser.js'
import { type ClockPort, systemClock } from './clock.js'
import {
  type AuthEndpoints,
  authEndpointsFromIssuer,
  CLI_CREDENTIAL_ACCOUNT_ID,
  CLI_CREDENTIAL_PROVIDER,
  DEFAULT_EXPIRY_SKEW_MILLISECONDS,
  DEFAULT_HTTP_TIMEOUT_MILLISECONDS,
  DEFAULT_LOGIN_TIMEOUT_MILLISECONDS,
  DEFAULT_SCOPES,
} from './config.js'
import { type EntropyPort, SystemEntropy } from './entropy.js'
import { newRequestId } from './errors.js'
import { type LoopbackListenerFactory, startLoopbackListener } from './loopback.js'
import { AuthMetadataStore } from './metadata.js'
import { CliOAuthClient } from './oauth-client.js'
import type { BrowserOpenerPort, FetchPort } from './ports.js'
import { AuthSessionService } from './service.js'
import { type RefreshGate, HostedTokenManager } from './token-manager.js'

export interface AuthCommandFlags extends RuntimeFlags {
  readonly 'api-url'?: string | undefined
  readonly 'authorize-url'?: string | undefined
  readonly 'token-url'?: string | undefined
  readonly 'revoke-url'?: string | undefined
}

const defaultFetch: FetchPort = (input, init) => fetch(input, init)

/** A credential-store adapter for hosts without a wired OS keychain. */
export class UnavailableOsCredentialAdapter implements OsCredentialAdapter {
  readonly available = false

  get(): Promise<never> {
    return Promise.reject(new Error('No operating-system credential store is available'))
  }

  set(): Promise<never> {
    return Promise.reject(new Error('No operating-system credential store is available'))
  }

  delete(): Promise<never> {
    return Promise.reject(new Error('No operating-system credential store is available'))
  }
}

export function defaultCredentialKey(): HostedOAuthCredentialKey {
  return {
    accountId: CLI_CREDENTIAL_ACCOUNT_ID,
    kind: 'hosted-oauth',
    provider: CLI_CREDENTIAL_PROVIDER,
  }
}

function configError(message: string): OcboxError {
  return new OcboxError({ code: 'CONFIG_INVALID', message, requestId: newRequestId() })
}

/**
 * Resolves the hosted API endpoints from flags/environment, or fails closed.
 *
 * When `requireBrowserAuthorizationEndpoint` is set (login), an explicit
 * browser authorization endpoint is mandatory: the pinned hosted OpenAPI
 * artifact (`96ea2292…`, servers `/v1`) defines `/auth/cli/authorize` only as
 * an *authenticated POST* web-consent route and publishes no browser-facing
 * GET authorization page that a CLI could open. Deriving one would fabricate a
 * URL that cannot work; until the hosted contract publishes the browser page
 * (T16 wiring), login fails closed unless `--authorize-url` (or
 * `OCBOX_AUTHORIZE_URL`) supplies the documented URL.
 */
export function resolveAuthEndpoints(
  flags: AuthCommandFlags,
  environment: NodeJS.ProcessEnv = process.env,
  options: { requireBrowserAuthorizationEndpoint?: boolean | undefined } = {},
): AuthEndpoints {
  const issuer =
    // Environment is an index signature; bracket access is required by TypeScript.
    // biome-ignore lint/complexity/useLiteralKeys: see explanation above
    flags['api-url'] ?? environment['OCBOX_API_URL']
  if (typeof issuer !== 'string' || issuer.trim().length === 0) {
    throw configError(
      'Set the hosted API URL with --api-url or the OCBOX_API_URL environment variable',
    )
  }
  const authorizeEndpoint =
    flags['authorize-url'] ??
    // Environment is an index signature; bracket access is required by TypeScript.
    // biome-ignore lint/complexity/useLiteralKeys: see explanation above
    environment['OCBOX_AUTHORIZE_URL']
  if (options.requireBrowserAuthorizationEndpoint === true) {
    if (typeof authorizeEndpoint !== 'string' || authorizeEndpoint.trim().length === 0) {
      throw configError(
        'The pinned hosted contract does not yet publish a browser authorization page; ' +
          'pass --authorize-url (or OCBOX_AUTHORIZE_URL) with the documented hosted ' +
          'authorization URL, or see docs/auth.md for the integration blocker',
      )
    }
  }
  try {
    return authEndpointsFromIssuer(issuer, {
      authorizationEndpoint: authorizeEndpoint,
      revocationEndpoint: flags['revoke-url'],
      tokenEndpoint: flags['token-url'],
    })
  } catch {
    throw configError('The hosted API URL is not a valid uncredentialed http(s) base URL')
  }
}

/** Builds the T3 credential store: OS adapter when present, protected file otherwise. */
export function createCredentialStore(
  environment: NodeJS.ProcessEnv = process.env,
): CredentialStore {
  const paths = resolveCurrentPlatformPaths(environment)
  if (paths.credentialDirectory === null) {
    throw configError('Protected credential storage is unavailable on this filesystem')
  }
  return new HostedOAuthCredentialStore(
    new UnavailableOsCredentialAdapter(),
    new ProtectedFileCredentialStore(paths.credentialDirectory),
  )
}

export interface CreateAuthSessionServiceOptions {
  readonly flags: AuthCommandFlags
  readonly environment?: NodeJS.ProcessEnv
  /** Null for status/logout, which resolve the issuer from stored metadata. */
  readonly endpoints?: AuthEndpoints | null
  readonly browser?: BrowserOpenerPort
  readonly fetch?: FetchPort
  readonly clock?: ClockPort
  readonly entropy?: EntropyPort
  readonly credentialStore?: CredentialStore
  readonly listenerFactory?: LoopbackListenerFactory
}

export function createAuthSessionService(
  options: CreateAuthSessionServiceOptions,
): AuthSessionService {
  const environment = options.environment ?? process.env
  const stateDirectory = resolveStateDirectory(options.flags, environment)
  const fetchPort = options.fetch ?? defaultFetch
  const clock = options.clock ?? systemClock
  return new AuthSessionService({
    browser: options.browser ?? new PlatformBrowserOpener(),
    clock,
    credentialKey: defaultCredentialKey(),
    credentialStore: options.credentialStore ?? createCredentialStore(environment),
    endpoints: options.endpoints ?? null,
    entropy: options.entropy ?? new SystemEntropy(),
    listenerFactory: options.listenerFactory ?? startLoopbackListener,
    loginTimeoutMilliseconds: DEFAULT_LOGIN_TIMEOUT_MILLISECONDS,
    metadataStore: new AuthMetadataStore(join(stateDirectory, 'auth.json')),
    oauth: (endpoints) =>
      new CliOAuthClient({
        clientId: endpoints.clientId,
        fetch: fetchPort,
        revocationEndpoint: endpoints.revocationEndpoint,
        timeoutMilliseconds: DEFAULT_HTTP_TIMEOUT_MILLISECONDS,
        tokenEndpoint: endpoints.tokenEndpoint,
      }),
  })
}

export interface CreateHostedTokenManagerOptions {
  readonly endpoints: AuthEndpoints
  readonly credentialStore: CredentialStore
  readonly credentialKey?: HostedOAuthCredentialKey
  readonly clock?: ClockPort
  readonly fetch?: FetchPort
  readonly expirySkewMilliseconds?: number
  readonly requiredScopes?: readonly string[]
  readonly onRefreshed?: (credential: HostedOAuthCredential) => Promise<void> | void
  readonly environment?: NodeJS.ProcessEnv
}

/**
 * Shared cross-process refresh coordinator over the T3 file-lock primitive.
 * Holding the state-directory lock across the token rotation ensures two CLI
 * processes can never present the same rotating refresh token concurrently
 * (which the server classifies as refresh reuse), and serializes the
 * read/rotate/write critical section. The bounded wait maps contention to a
 * typed conflict error instead of an unbounded stall; status and logout are
 * unaffected.
 */
export function createRefreshGate(stateDirectory: string): RefreshGate {
  const lock = new ExclusiveFileLock({
    createCancelledError: () => new AtomicStoreCancelledError(),
    createTimeoutError: () => new AtomicStoreConflictError(),
  })
  return async (action) => {
    try {
      return await lock.withLock(join(stateDirectory, 'auth.refresh.lock'), undefined, action)
    } catch (error) {
      if (error instanceof AtomicStoreConflictError || error instanceof AtomicStoreCancelledError) {
        throw new OcboxError({
          code: 'OPERATION_CONFLICT',
          message: 'Another CLI process is rotating the stored credential; try again shortly',
          requestId: newRequestId(),
        })
      }
      throw error
    }
  }
}

/**
 * Public token/authenticated-client ports for the hosted provider (T14).
 * Tokens are read and rotated only through the T3 credential store, behind the
 * cross-process refresh gate, and bound to the configured issuer through the
 * machine-level auth metadata.
 */
export function createHostedTokenManager(
  options: CreateHostedTokenManagerOptions,
): HostedTokenManager {
  const fetchPort = options.fetch ?? defaultFetch
  const environment = options.environment ?? process.env
  const oauth = new CliOAuthClient({
    clientId: options.endpoints.clientId,
    fetch: fetchPort,
    revocationEndpoint: options.endpoints.revocationEndpoint,
    timeoutMilliseconds: DEFAULT_HTTP_TIMEOUT_MILLISECONDS,
    tokenEndpoint: options.endpoints.tokenEndpoint,
  })
  const stateDirectory = resolveStateDirectory({}, environment)
  const metadataRepository = new AuthMetadataStore(join(stateDirectory, 'auth.json'))
  return new HostedTokenManager({
    clock: options.clock ?? systemClock,
    key: options.credentialKey ?? defaultCredentialKey(),
    store: options.credentialStore,
    binding: {
      expectedIssuer: options.endpoints.issuer,
      metadataRepository,
    },
    expirySkewMilliseconds: options.expirySkewMilliseconds ?? DEFAULT_EXPIRY_SKEW_MILLISECONDS,
    refreshGate: createRefreshGate(stateDirectory),
    ...(options.onRefreshed === undefined ? {} : { onRefreshed: options.onRefreshed }),
    requiredScopes: options.requiredScopes ?? [...DEFAULT_SCOPES],
    refresh: (input) => oauth.refresh(input),
  })
}

export interface CreateAuthenticatedHttpClientOptions {
  readonly tokens: HostedTokenManager
  readonly fetch?: FetchPort
  readonly timeoutMilliseconds?: number
  /** Certified API origin the credential was minted for; requests are bound. */
  readonly apiOrigin?: string | undefined
}

export function createAuthenticatedHttpClient(
  options: CreateAuthenticatedHttpClientOptions,
): AuthenticatedHttpClient {
  return new AuthenticatedHttpClient({
    apiOrigin: options.apiOrigin ?? options.tokens.boundIssuer,
    fetch: options.fetch ?? defaultFetch,
    timeoutMilliseconds: options.timeoutMilliseconds ?? DEFAULT_HTTP_TIMEOUT_MILLISECONDS,
    tokens: options.tokens,
  })
}

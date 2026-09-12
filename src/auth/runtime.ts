import { isAbsolute, join, resolve } from 'node:path'
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
  type HostedProtocolEndpoints,
} from './config.js'
import { type EntropyPort, SystemEntropy } from './entropy.js'
import { newRequestId } from './errors.js'
import { type LoopbackListenerFactory, startLoopbackListener } from './loopback.js'
import { AuthMetadataStore } from './metadata.js'
import { CliOAuthClient } from './oauth-client.js'
import type { BrowserOpenerPort, FetchPort } from './ports.js'
import { AuthSessionService } from './service.js'
import { createSessionGate } from './session-gate.js'
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
 * An explicit browser authorization endpoint is always mandatory: the pinned
 * hosted OpenAPI artifact (`96ea2292…`, servers `/v1`) defines
 * `/auth/cli/authorize` only as an *authenticated POST* web-consent route and
 * publishes no browser-facing GET authorization page that a CLI could open.
 * Deriving one would fabricate a URL that cannot work; until the hosted
 * contract publishes the browser page (T16 wiring), login fails closed unless
 * `--authorize-url` (or `OCBOX_AUTHORIZE_URL`) supplies the documented URL.
 */
export function resolveAuthEndpoints(
  flags: AuthCommandFlags,
  environment: NodeJS.ProcessEnv = process.env,
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
  if (typeof authorizeEndpoint !== 'string' || authorizeEndpoint.trim().length === 0) {
    throw configError(
      'The pinned hosted contract does not yet publish a browser authorization page; ' +
        'pass --authorize-url (or OCBOX_AUTHORIZE_URL) with the documented hosted ' +
        'authorization URL, or see docs/auth.md for the integration blocker',
    )
  }
  try {
    return authEndpointsFromIssuer(issuer, {
      authorizationEndpoint: authorizeEndpoint,
      revocationEndpoint: flags['revoke-url'],
      tokenEndpoint: flags['token-url'],
    })
  } catch (error) {
    // Validator messages describe only the URL shape (protocol, host class,
    // credentials, query/fragment) and never echo secret material, so they are
    // safe to surface to the integrator diagnosing a rejected base URL.
    const detail = error instanceof Error ? `: ${error.message}` : ''
    throw configError(`The hosted API URL is not a valid uncredentialed http(s) base URL${detail}`)
  }
}

/**
 * Resolves the state directory shared by login and the hosted token manager.
 * An explicit directory wins, then command flags/environment, then the
 * platform default — so T14 resolves exactly the metadata and auth-state lock
 * location that `ocbox auth login` wrote. Bearer material itself still follows
 * the T3 platform credential directory, never the state directory.
 */
export function resolveAuthStateDirectory(
  options: {
    readonly flags?: AuthCommandFlags | undefined
    readonly stateDirectory?: string | undefined
    readonly environment?: NodeJS.ProcessEnv | undefined
  } = {},
): string {
  if (typeof options.stateDirectory === 'string' && options.stateDirectory.trim().length > 0) {
    return resolve(options.stateDirectory)
  }
  return resolveStateDirectory(options.flags ?? {}, options.environment ?? process.env)
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
    // Login/status/logout snapshot-and-commit sections run under a bounded
    // cross-process lock so two CLI processes never interleave their reads
    // with another actor's credential/metadata writes.
    sessionGate: createSessionGate(stateDirectory),
    oauth: (endpoints) =>
      new CliOAuthClient({
        apiBase: endpoints.issuer,
        clientId: endpoints.clientId,
        fetch: fetchPort,
        revocationEndpoint: endpoints.revocationEndpoint,
        timeoutMilliseconds: DEFAULT_HTTP_TIMEOUT_MILLISECONDS,
        tokenEndpoint: endpoints.tokenEndpoint,
      }),
  })
}

export interface CreateHostedTokenManagerOptions {
  readonly endpoints: HostedProtocolEndpoints
  /**
   * The exact resolved state directory — `resolveStateDirectory(flags,
   * environment)` — shared with `auth login`. The binding metadata repository
   * and the cross-process refresh gate are both derived from it, so they can
   * never disagree; a manager pointed at a directory other than the one login
   * used fails closed with a binding error instead of trusting foreign
   * metadata.
   */
  readonly stateDirectory: string
  readonly credentialStore: CredentialStore
  readonly credentialKey?: HostedOAuthCredentialKey
  readonly clock?: ClockPort
  readonly fetch?: FetchPort
  readonly expirySkewMilliseconds?: number
  readonly requiredScopes?: readonly string[]
  readonly onRefreshed?: (credential: HostedOAuthCredential) => Promise<void> | void
}

/**
 * Shared cross-process refresh coordinator over the T3 file-lock primitive.
 * Holding the state-directory lock across the token rotation ensures two CLI
 * processes can never present the same rotating refresh token concurrently
 * (which the server classifies as refresh reuse), and serializes the
 * read/rotate/write critical section. The bounded wait maps contention to a
 * typed conflict error instead of an unbounded stall, and caller cancellation
 * to a typed cancelled error. It is the same outer gate used by session
 * status, login commits, and logout cleanup.
 */
export function createRefreshGate(stateDirectory: string): RefreshGate {
  const gate = createSessionGate(stateDirectory)
  return (action, signal) => gate(action, signal)
}

/**
 * Public token/authenticated-client ports for the hosted provider (T14).
 * Tokens are read and rotated only through the T3 credential store, behind the
 * cross-process refresh gate, and bound to the configured issuer, client, and
 * credential identity through the machine-level auth metadata.
 */
export function createHostedTokenManager(
  options: CreateHostedTokenManagerOptions,
): HostedTokenManager {
  if (!isAbsolute(options.stateDirectory)) {
    throw configError(
      'Pass the absolute resolved state directory (resolveStateDirectory(flags)) so the ' +
        'credential refresh gate and the binding metadata share one location',
    )
  }
  const fetchPort = options.fetch ?? defaultFetch
  const oauth = new CliOAuthClient({
    apiBase: options.endpoints.issuer,
    clientId: options.endpoints.clientId,
    fetch: fetchPort,
    revocationEndpoint: options.endpoints.revocationEndpoint,
    timeoutMilliseconds: DEFAULT_HTTP_TIMEOUT_MILLISECONDS,
    tokenEndpoint: options.endpoints.tokenEndpoint,
  })
  const metadataRepository = new AuthMetadataStore(join(options.stateDirectory, 'auth.json'))
  return new HostedTokenManager({
    clock: options.clock ?? systemClock,
    key: options.credentialKey ?? defaultCredentialKey(),
    store: options.credentialStore,
    binding: {
      expectedClientId: options.endpoints.clientId,
      expectedIssuer: options.endpoints.issuer,
      metadataRepository,
    },
    expirySkewMilliseconds: options.expirySkewMilliseconds ?? DEFAULT_EXPIRY_SKEW_MILLISECONDS,
    refreshGate: createRefreshGate(options.stateDirectory),
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
  const apiOrigin = options.apiOrigin ?? options.tokens.boundIssuer
  if (apiOrigin === undefined) {
    // Destination binding is mandatory; an unbound token manager must not yield
    // a client that could attach the bearer to any URL.
    throw configError(
      'Cannot build the authenticated API client without a bound hosted API origin; ' +
        'configure the hosted API URL or pass an explicit apiOrigin',
    )
  }
  return new AuthenticatedHttpClient({
    apiOrigin,
    fetch: options.fetch ?? defaultFetch,
    timeoutMilliseconds: options.timeoutMilliseconds ?? DEFAULT_HTTP_TIMEOUT_MILLISECONDS,
    tokens: options.tokens,
  })
}

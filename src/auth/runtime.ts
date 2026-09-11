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
import { HostedTokenManager } from './token-manager.js'

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

/** Resolves the hosted API endpoints from flags/environment, or fails closed. */
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
  try {
    return authEndpointsFromIssuer(issuer, {
      authorizationEndpoint: flags['authorize-url'],
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
}

/**
 * Public token/authenticated-client ports for the later hosted provider (T14).
 * Tokens are read and rotated only through the T3 credential store.
 */
export function createHostedTokenManager(
  options: CreateHostedTokenManagerOptions,
): HostedTokenManager {
  const fetchPort = options.fetch ?? defaultFetch
  const oauth = new CliOAuthClient({
    clientId: options.endpoints.clientId,
    fetch: fetchPort,
    revocationEndpoint: options.endpoints.revocationEndpoint,
    timeoutMilliseconds: DEFAULT_HTTP_TIMEOUT_MILLISECONDS,
    tokenEndpoint: options.endpoints.tokenEndpoint,
  })
  return new HostedTokenManager({
    clock: options.clock ?? systemClock,
    key: options.credentialKey ?? defaultCredentialKey(),
    store: options.credentialStore,
    expirySkewMilliseconds: options.expirySkewMilliseconds ?? DEFAULT_EXPIRY_SKEW_MILLISECONDS,
    ...(options.onRefreshed === undefined ? {} : { onRefreshed: options.onRefreshed }),
    requiredScopes: options.requiredScopes ?? [...DEFAULT_SCOPES],
    refresh: (input) => oauth.refresh(input),
  })
}

export interface CreateAuthenticatedHttpClientOptions {
  readonly tokens: HostedTokenManager
  readonly fetch?: FetchPort
  readonly timeoutMilliseconds?: number
}

export function createAuthenticatedHttpClient(
  options: CreateAuthenticatedHttpClientOptions,
): AuthenticatedHttpClient {
  return new AuthenticatedHttpClient({
    fetch: options.fetch ?? defaultFetch,
    timeoutMilliseconds: options.timeoutMilliseconds ?? DEFAULT_HTTP_TIMEOUT_MILLISECONDS,
    tokens: options.tokens,
  })
}

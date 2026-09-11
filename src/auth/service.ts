import type { CredentialStore, HostedOAuthCredentialKey } from '../credentials/store.js'
import type { ClockPort } from './clock.js'
import { type AuthEndpoints, authEndpointsFromIssuer, buildAuthorizationUrl } from './config.js'
import type { EntropyPort } from './entropy.js'
import type { LoopbackListener, LoopbackListenerFactory } from './loopback.js'
import { type AuthMetadataRepository, AuthMetadataSchema } from './metadata.js'
import type { CliOAuthClientPort, RevokeInput } from './oauth-client.js'
import { codeChallengeS256, generateCodeVerifier, generateState } from './pkce.js'
import type { BrowserOpenerPort } from './ports.js'
import { credentialFromTokenPair } from './token-manager.js'

export interface AuthStatusView {
  readonly loggedIn: boolean
  readonly issuer: string | null
  readonly audience: 'cli' | null
  readonly scopes: readonly string[]
  readonly expiresAt: string | null
  readonly expired: boolean
}

export interface AuthLoginView extends AuthStatusView {
  readonly browserOpened: boolean
}

export interface AuthLogoutView {
  readonly loggedOut: true
  readonly revocationAttempted: boolean
  readonly revoked: boolean
}

export interface AuthLoginOptions {
  readonly signal?: AbortSignal | undefined
  readonly openBrowser?: boolean | undefined
  readonly onAuthorizationUrl?: ((url: string, opened: boolean) => void) | undefined
}

export interface AuthSessionServiceOptions {
  /** Null for status/logout, which derive the issuer from stored metadata. */
  readonly endpoints: AuthEndpoints | null
  readonly credentialStore: CredentialStore
  readonly credentialKey: HostedOAuthCredentialKey
  readonly metadataStore: AuthMetadataRepository
  readonly oauth: (endpoints: AuthEndpoints) => CliOAuthClientPort
  readonly entropy: EntropyPort
  readonly clock: ClockPort
  readonly browser: BrowserOpenerPort
  readonly listenerFactory: LoopbackListenerFactory
  readonly loginTimeoutMilliseconds: number
}

function statusFrom(
  metadata: { issuer: string; audience: 'cli'; scopes: readonly string[] } | null,
  credential: { scopes: readonly string[]; expiresAt: string | null } | null,
  now: number,
): AuthStatusView {
  if (metadata === null || credential === null) {
    return {
      audience: null,
      expired: false,
      expiresAt: null,
      issuer: null,
      loggedIn: false,
      scopes: [],
    }
  }
  const expiry = credential.expiresAt === null ? null : Date.parse(credential.expiresAt)
  const expired = expiry !== null && (Number.isNaN(expiry) || expiry <= now)
  return {
    audience: metadata.audience,
    expired,
    expiresAt: credential.expiresAt,
    issuer: metadata.issuer,
    loggedIn: !expired,
    scopes: credential.scopes,
  }
}

/** Orchestrates the public-client login, status, and logout lifecycle. */
export class AuthSessionService {
  readonly #options: AuthSessionServiceOptions

  constructor(options: AuthSessionServiceOptions) {
    this.#options = options
  }

  async login(options: AuthLoginOptions = {}): Promise<AuthLoginView> {
    const endpoints = this.#options.endpoints
    if (endpoints === null) throw new TypeError('Login requires resolved auth endpoints')
    const codeVerifier = generateCodeVerifier(this.#options.entropy)
    const codeChallenge = codeChallengeS256(codeVerifier)
    const state = generateState(this.#options.entropy)
    const listener: LoopbackListener = await this.#options.listenerFactory({
      expectedState: state,
      timeoutMilliseconds: this.#options.loginTimeoutMilliseconds,
    })
    try {
      const authorizationUrl = buildAuthorizationUrl(endpoints, {
        codeChallenge,
        redirectUri: listener.redirectUri,
        state,
      })
      const opened =
        options.openBrowser === false
          ? false
          : await this.#options.browser.open(authorizationUrl).catch(() => false)
      options.onAuthorizationUrl?.(authorizationUrl, opened)
      const callback = await listener.waitForCallback(options.signal)
      const pair = await this.#options.oauth(endpoints).exchangeAuthorizationCode({
        code: callback.code,
        codeVerifier,
        redirectUri: listener.redirectUri,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      const now = this.#options.clock.now()
      const credential = credentialFromTokenPair(pair, now)
      await this.#options.credentialStore.set(this.#options.credentialKey, credential)
      const metadata = AuthMetadataSchema.parse({
        audience: endpoints.audience,
        clientId: endpoints.clientId,
        expiresAt: credential.expiresAt,
        identity: this.#options.credentialKey,
        issuer: endpoints.issuer,
        schemaVersion: 1,
        scopes: credential.scopes,
        updatedAt: new Date(now).toISOString(),
      })
      await this.#options.metadataStore.save(metadata)
      const status = statusFrom(metadata, credential, now)
      return { ...status, browserOpened: opened }
    } finally {
      await listener.close().catch(() => undefined)
    }
  }

  async status(): Promise<AuthStatusView> {
    const metadata = await this.#options.metadataStore.load()
    if (metadata === null) return statusFrom(null, null, this.#options.clock.now())
    const credential = await this.#options.credentialStore.get(metadata.identity)
    if (credential === null) {
      await this.#options.metadataStore.clear().catch(() => undefined)
      return statusFrom(null, null, this.#options.clock.now())
    }
    return statusFrom(metadata, credential, this.#options.clock.now())
  }

  async logout(options: { signal?: AbortSignal | undefined } = {}): Promise<AuthLogoutView> {
    const metadata = await this.#options.metadataStore.load()
    const credential =
      metadata === null ? null : await this.#options.credentialStore.get(metadata.identity)
    let revocationAttempted = false
    let revoked = false
    if (credential !== null) {
      const endpoints =
        this.#options.endpoints ??
        (metadata === null ? null : authEndpointsFromIssuer(metadata.issuer))
      if (endpoints !== null) {
        revocationAttempted = true
        const token = credential.refreshToken ?? credential.accessToken
        const input: RevokeInput = {
          token,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }
        try {
          await this.#options.oauth(endpoints).revoke(input)
          revoked = true
        } catch {
          // Local material is always cleared even when revocation fails.
          revoked = false
        }
      }
    }
    const identity = metadata?.identity ?? this.#options.credentialKey
    await this.#options.credentialStore.delete(identity).catch(() => undefined)
    await this.#options.metadataStore.clear().catch(() => undefined)
    return { loggedOut: true, revocationAttempted, revoked }
  }
}

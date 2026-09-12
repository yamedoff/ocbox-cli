import type {
  CredentialStore,
  HostedOAuthCredential,
  HostedOAuthCredentialKey,
} from '../credentials/store.js'
import { OcboxError } from '../errors/index.js'
import type { ClockPort } from './clock.js'
import {
  type AuthEndpoints,
  buildAuthorizationUrl,
  DEFAULT_CLIENT_ID,
  type HostedProtocolEndpoints,
  normalizeIssuer,
  protocolEndpointsFromIssuer,
} from './config.js'
import { newRequestId } from './errors.js'
import type { EntropyPort } from './entropy.js'
import type { LoopbackListener, LoopbackListenerFactory } from './loopback.js'
import { type AuthMetadata, type AuthMetadataRepository, AuthMetadataSchema } from './metadata.js'
import type { CliOAuthClientPort, RevokeInput } from './oauth-client.js'
import { codeChallengeS256, generateCodeVerifier, generateState } from './pkce.js'
import type { BrowserOpenerPort } from './ports.js'
import type { SessionGate } from './session-gate.js'
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
  readonly oauth: (endpoints: HostedProtocolEndpoints) => CliOAuthClientPort
  readonly entropy: EntropyPort
  readonly clock: ClockPort
  readonly browser: BrowserOpenerPort
  readonly listenerFactory: LoopbackListenerFactory
  readonly loginTimeoutMilliseconds: number
  /** Serializes session lifecycle snapshot-and-commit sections across processes. */
  readonly sessionGate?: SessionGate | undefined
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

function staleStateError(message: string): OcboxError {
  return new OcboxError({
    code: 'INVALID_STATE',
    message,
    requestId: newRequestId(),
  })
}

function sameIdentity(a: HostedOAuthCredentialKey, b: HostedOAuthCredentialKey): boolean {
  return a.kind === b.kind && a.provider === b.provider && a.accountId === b.accountId
}

function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const expected = new Set(a)
  if (expected.size !== a.length || new Set(b).size !== b.length) return false
  return b.every((scope) => expected.has(scope))
}

/** Orchestrates the public-client login, status, and logout lifecycle. */
export class AuthSessionService {
  readonly #options: AuthSessionServiceOptions

  constructor(options: AuthSessionServiceOptions) {
    this.#options = options
  }

  /** Runs `action` under the injected cross-process session gate when present. */
  #gated<Result>(action: () => Promise<Result>, signal?: AbortSignal | undefined): Promise<Result> {
    const gate = this.#options.sessionGate
    return gate === undefined ? action() : gate(action, signal)
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
    // Everything after the listener bind is inside try/finally: a failure at
    // any later step (including reading prior state) must close the listener
    // and release the ephemeral port.
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
      // Prior state is snapshotted under the session gate immediately before
      // the commit so a failed metadata commit restores exactly what was on
      // disk for this generation instead of leaving a half-written pair.
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
      await this.#gated(() => this.#commit(credential, metadata, options.signal), options.signal)
      const status = statusFrom(metadata, credential, now)
      return { ...status, browserOpened: opened }
    } finally {
      await listener.close().catch(() => undefined)
    }
  }

  /**
   * Snapshots prior state, commits the new credential/metadata pair, and rolls
   * both stores back on a failed metadata commit. The gate is held across the
   * snapshot/commit/rollback so a concurrent CLI process cannot interleave a
   * login, logout, or refresh with this critical section. If restoration
   * itself fails, a typed invalid-state error replaces the original commit
   * error so callers are never told rollback succeeded while credential and
   * metadata generations may disagree.
   */
  async #commit(
    credential: HostedOAuthCredential,
    metadata: AuthMetadata,
    signal?: AbortSignal,
  ): Promise<void> {
    const previousCredential = await this.#options.credentialStore.get(this.#options.credentialKey)
    const previousMetadata = await this.#options.metadataStore.load(signal)
    await this.#options.credentialStore.set(this.#options.credentialKey, credential)
    try {
      await this.#options.metadataStore.save(metadata, signal)
    } catch (error) {
      const restored = await this.#restore(previousCredential, previousMetadata)
      if (!restored) {
        throw staleStateError(
          'Login could not commit or restore local authentication state; ' +
            'run `ocbox auth logout` and inspect the state directory',
        )
      }
      throw error
    }
  }

  /** Restores both halves and reports whether the pre-login state is exact. */
  async #restore(
    previousCredential: HostedOAuthCredential | null,
    previousMetadata: AuthMetadata | null,
  ): Promise<boolean> {
    let restored = true
    try {
      if (previousCredential === null) {
        await this.#options.credentialStore.delete(this.#options.credentialKey)
      } else {
        await this.#options.credentialStore.set(this.#options.credentialKey, previousCredential)
      }
    } catch {
      restored = false
    }
    try {
      if (previousMetadata === null) await this.#options.metadataStore.clear()
      else await this.#options.metadataStore.save(previousMetadata)
    } catch {
      restored = false
    }
    return restored
  }

  async status(): Promise<AuthStatusView> {
    return this.#gated(async () => {
      let metadata: AuthMetadata | null
      let credential: HostedOAuthCredential | null
      try {
        metadata = await this.#options.metadataStore.load()
        credential = await this.#options.credentialStore.get(this.#options.credentialKey)
      } catch {
        throw staleStateError(
          'Stored authentication state could not be validated; run `ocbox auth logout`',
        )
      }
      if (metadata === null) {
        if (credential !== null) {
          throw staleStateError(
            'Stored credentials have no matching login metadata; run `ocbox auth logout`',
          )
        }
        return statusFrom(null, null, this.#options.clock.now())
      }
      if (!sameIdentity(metadata.identity, this.#options.credentialKey)) {
        throw staleStateError(
          'Stored login metadata points to an unexpected credential identity; ' +
            'run `ocbox auth logout`',
        )
      }
      if (credential === null) {
        // Stale metadata for a missing credential is cleared under the gate; a
        // failed clear surfaces as a typed failure instead of a false
        // logged-out claim while stale state remains on disk.
        try {
          await this.#options.metadataStore.clear()
        } catch {
          throw staleStateError(
            'Stored authentication metadata is stale and could not be cleared; ' +
              'run `ocbox auth logout` again and inspect the state directory',
          )
        }
        return statusFrom(null, null, this.#options.clock.now())
      }
      const expectedClientId = this.#options.endpoints?.clientId ?? DEFAULT_CLIENT_ID
      let canonicalIssuer: string
      try {
        canonicalIssuer = normalizeIssuer(metadata.issuer)
      } catch {
        throw staleStateError(
          'Stored login metadata contains an invalid hosted API URL; run `ocbox auth logout`',
        )
      }
      if (
        canonicalIssuer !== metadata.issuer ||
        metadata.clientId !== expectedClientId ||
        !sameScopes(metadata.scopes, credential.scopes)
      ) {
        throw staleStateError(
          'Stored login metadata does not match the credential generation; ' +
            'run `ocbox auth logout` then `ocbox auth login`',
        )
      }
      return statusFrom(metadata, credential, this.#options.clock.now())
    })
  }

  async logout(options: { signal?: AbortSignal | undefined } = {}): Promise<AuthLogoutView> {
    return this.#gated(async () => {
      // Once the state gate is acquired, local cleanup is unconditional. The
      // caller signal still cancels the remote revoke, but cannot interrupt
      // deletion halfway and leave a credential/metadata split.
      let metadata: AuthMetadata | null = null
      let credential: HostedOAuthCredential | null = null
      try {
        metadata = await this.#options.metadataStore.load()
      } catch {
        // A malformed/unreadable metadata record cannot identify a safe remote
        // endpoint, but it must not prevent local credential deletion.
      }
      // Always target the configured CLI slot. Untrusted/stale metadata must
      // never redirect local deletion to a different credential identity.
      try {
        credential = await this.#options.credentialStore.get(this.#options.credentialKey)
      } catch {
        // Cleanup below still attempts the store's delete operation directly.
      }
      let revocationAttempted = false
      let revoked = false
      if (
        credential !== null &&
        metadata !== null &&
        sameIdentity(metadata.identity, this.#options.credentialKey)
      ) {
        try {
          const endpoints = this.#logoutEndpoints(metadata)
          revocationAttempted = true
          const token = credential.refreshToken ?? credential.accessToken
          const input: RevokeInput = {
            token,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }
          await this.#options.oauth(endpoints).revoke(input)
          revoked = true
        } catch {
          // Invalid legacy metadata and remote revocation failures never block
          // local cleanup; the outcome remains explicit in the returned view.
          revoked = false
        }
      }
      // Both deletions target exactly the generation that was read above; the
      // gate prevents a concurrent login/logout/refresh from interleaving a
      // different generation between the read and the delete. Every cleanup
      // step is attempted even after an earlier failure; a failed step is
      // reported truthfully instead of claiming the material was cleared.
      let cleanupError: unknown = null
      try {
        await this.#options.credentialStore.delete(this.#options.credentialKey)
      } catch (error) {
        cleanupError ??= error
      }
      try {
        await this.#options.metadataStore.clear()
      } catch (error) {
        cleanupError ??= error
      }
      if (cleanupError !== null) {
        throw staleStateError(
          'Local authentication material could not be fully cleared; ' +
            'run `ocbox auth logout` again and inspect the state directory',
        )
      }
      return { loggedOut: true, revocationAttempted, revoked }
    }, options.signal)
  }

  /** Resolves a revocation endpoint only when it agrees with stored binding facts. */
  #logoutEndpoints(metadata: AuthMetadata): HostedProtocolEndpoints {
    const configured = this.#options.endpoints
    if (configured !== null) {
      if (configured.issuer !== metadata.issuer || configured.clientId !== metadata.clientId) {
        throw staleStateError('Configured authentication endpoints do not match the stored login')
      }
      return configured
    }
    if (metadata.clientId !== DEFAULT_CLIENT_ID) {
      throw staleStateError('Stored login metadata names an unexpected OAuth client')
    }
    return protocolEndpointsFromIssuer(metadata.issuer, {
      clientId: metadata.clientId,
      scopes: metadata.scopes,
    })
  }
}

import {
  type CredentialStore,
  type HostedOAuthCredential,
  type HostedOAuthCredentialKey,
  HostedOAuthCredentialSchema,
} from '../credentials/store.js'
import type { ClockPort } from './clock.js'
import { AuthBindingError, isLoginRequired, LoginRequiredError } from './errors.js'
import type { AuthMetadataRepository } from './metadata.js'
import type { CliTokenPair } from './oauth-client.js'

export interface TokenRefreshInput {
  readonly refreshToken: string
  readonly signal?: AbortSignal | undefined
}

export type TokenRefresh = (input: TokenRefreshInput) => Promise<CliTokenPair>

export interface RefreshRequest {
  readonly signal?: AbortSignal | undefined
  /**
   * Set when the refresh is triggered by a 401 for this access token. Rotation
   * is then forced even if the credential is not yet time-expiring, but only
   * while the store still holds exactly this token; a newer generation another
   * process already rotated to is adopted as-is.
   */
  readonly rejectedAccessToken?: string | undefined
}

/**
 * Cross-process refresh coordinator. The in-process operation chain serializes
 * refreshes per object; hosts with a shared state directory inject a bounded
 * coordinator (e.g. the T3 exclusive file lock) so two CLI processes can never
 * present the same rotating refresh token to the server at once, which would
 * be classified as refresh reuse and could revoke the family. The signal makes
 * waiting for another process cancellable.
 */
export type RefreshGate = <Result>(
  action: () => Promise<Result>,
  signal?: AbortSignal | undefined,
) => Promise<Result>

/**
 * Issuance binding facts. A stored credential is only usable when the
 * machine-level metadata attests that it was minted by the same configured
 * issuer for the same client and `cli` audience, for exactly this credential
 * identity, and that it covers the required scopes — staging or foreign-host
 * credentials cannot be replayed against another configured API.
 */
export interface CredentialBinding {
  readonly expectedIssuer: string
  readonly expectedClientId: string
  readonly metadataRepository: AuthMetadataRepository
}

export interface HostedTokenManagerOptions {
  readonly store: CredentialStore
  readonly key: HostedOAuthCredentialKey
  readonly clock: ClockPort
  readonly refresh: TokenRefresh
  readonly expirySkewMilliseconds: number
  readonly requiredScopes?: readonly string[]
  readonly onRefreshed?: (credential: HostedOAuthCredential) => Promise<void> | void
  readonly refreshGate?: RefreshGate | undefined
  readonly binding?: CredentialBinding | undefined
}

/** Converts a validated token pair into the T3 credential shape. */
export function credentialFromTokenPair(pair: CliTokenPair, now: number): HostedOAuthCredential {
  return HostedOAuthCredentialSchema.parse({
    accessToken: pair.accessToken,
    expiresAt: new Date(now + pair.expiresIn * 1_000).toISOString(),
    refreshToken: pair.refreshToken,
    scopes: pair.scope.split(' ').filter((scope) => scope.length > 0),
    tokenType: 'Bearer',
  })
}

function sameCredential(a: HostedOAuthCredential, b: HostedOAuthCredential): boolean {
  return (
    a.accessToken === b.accessToken &&
    a.refreshToken === b.refreshToken &&
    a.expiresAt === b.expiresAt &&
    a.tokenType === b.tokenType &&
    a.scopes.length === b.scopes.length &&
    a.scopes.every((scope, index) => scope === b.scopes[index])
  )
}

function sameIdentity(a: HostedOAuthCredentialKey, b: HostedOAuthCredentialKey): boolean {
  return a.kind === b.kind && a.provider === b.provider && a.accountId === b.accountId
}

/**
 * Sole reader/writer of bearer material. It enforces origin/client/identity/
 * scope binding, serializes concurrent refreshes (in-process, and across
 * processes through the injected refresh gate), and clears local material on
 * reuse/revocation so callers see a typed login error — but never deletes
 * material that a concurrent actor already replaced.
 */
export class HostedTokenManager {
  readonly #options: HostedTokenManagerOptions
  #inflight: { readonly promise: Promise<HostedOAuthCredential>; readonly forced: boolean } | null =
    null

  constructor(options: HostedTokenManagerOptions) {
    this.#options = options
  }

  read(): Promise<HostedOAuthCredential | null> {
    return this.#options.store.get(this.#options.key)
  }

  clear(): Promise<void> {
    return this.#options.store.delete(this.#options.key)
  }

  /** Null unless the manager was built with a pinned issuance binding. */
  get boundIssuer(): string | undefined {
    return this.#options.binding?.expectedIssuer
  }

  /**
   * Deletes the stored credential only when it is still exactly the snapshot
   * the caller acted on. Returns false when a concurrent actor rotated or
   * replaced it — the caller must not destroy newer material. The comparison
   * and deletion run as one critical section under the cross-process refresh
   * gate, so no other process can replace the credential in between.
   */
  clearIfToken(token: string): Promise<boolean> {
    return this.#clearIf((current) => current.accessToken === token)
  }

  /**
   * Deletes the stored credential only when it still matches the full snapshot
   * used by a failed rotation, preserving anything a concurrent process wrote
   * in the meantime. The comparison and deletion run as one critical section
   * under the cross-process refresh gate.
   */
  clearIfCredential(snapshot: HostedOAuthCredential): Promise<boolean> {
    return this.#clearIf((current) => sameCredential(current, snapshot))
  }

  async getValidCredential(signal?: AbortSignal): Promise<HostedOAuthCredential> {
    await this.#assertBinding(signal)
    const credential = await this.#options.store.get(this.#options.key)
    if (credential === null) throw new LoginRequiredError()
    this.#assertScopes(credential)
    return this.#isExpiring(credential) ? this.refresh({ signal }) : credential
  }

  /**
   * Rotates the stored credential at most once per generation.
   *
   * Proactive callers (no `rejectedAccessToken`) re-read the store inside the
   * gate and adopt a fresher generation another process already rotated to
   * instead of burning the current refresh token a second time. Waiting for
   * the cross-process gate is cancellable through `signal`; a bare
   * `AbortSignal` is accepted for convenience.
   */
  refresh(request: RefreshRequest | AbortSignal = {}): Promise<HostedOAuthCredential> {
    const options: RefreshRequest = request instanceof AbortSignal ? { signal: request } : request
    const forced = options.rejectedAccessToken !== undefined
    const previous = this.#inflight
    // Only proactive callers may adopt an in-flight rotation's result, and
    // only when it is itself proactive: a forced (401-triggered) caller must
    // re-evaluate the store inside the gate instead of inheriting a decision
    // that may have been "no rotation needed".
    if (previous !== null && !forced && !previous.forced) return previous.promise
    const operation = (async () => {
      if (previous !== null) await previous.promise.catch(() => undefined)
      const gate: RefreshGate = (action) =>
        this.#options.refreshGate === undefined
          ? action()
          : this.#options.refreshGate(action, options.signal)
      return gate(() => this.#performRefresh(options))
    })()
    const registered = operation.finally(() => {
      if (this.#inflight?.promise === registered) this.#inflight = null
    })
    this.#inflight = { promise: registered, forced }
    // Callers await the registered promise so its settlement is always
    // observed even when no later operation chains behind it.
    return registered
  }

  async #assertBinding(signal?: AbortSignal): Promise<void> {
    const binding = this.#options.binding
    if (binding === undefined) return
    const metadata = await binding.metadataRepository.load(signal)
    if (metadata === null) {
      throw new AuthBindingError(
        undefined,
        'No login metadata attests this credential; run `ocbox auth login`',
      )
    }
    if (
      !sameIdentity(metadata.identity, this.#options.key) ||
      metadata.clientId !== binding.expectedClientId ||
      metadata.audience !== 'cli' ||
      metadata.issuer !== binding.expectedIssuer
    ) {
      // Error messages cannot carry URLs/hosts (redaction-controlled), so the
      // issuance origin is not echoed back; the operator identifies it by rerun.
      throw new AuthBindingError(
        undefined,
        'The stored credential was minted by a different hosted API or client; ' +
          'run `ocbox auth logout` then `ocbox auth login` with the matching --api-url',
      )
    }
    for (const scope of this.#options.requiredScopes ?? []) {
      if (!metadata.scopes.includes(scope)) {
        throw new AuthBindingError(
          undefined,
          'The stored login metadata does not attest the required scopes; ' +
            'run `ocbox auth logout` then `ocbox auth login`',
        )
      }
    }
  }

  #assertScopes(credential: HostedOAuthCredential): void {
    for (const scope of this.#options.requiredScopes ?? []) {
      if (!credential.scopes.includes(scope)) throw new AuthBindingError()
    }
  }

  #isExpiring(credential: HostedOAuthCredential): boolean {
    if (credential.expiresAt === null) return false
    const expiry = Date.parse(credential.expiresAt)
    if (Number.isNaN(expiry)) return true
    return expiry - this.#options.clock.now() <= this.#options.expirySkewMilliseconds
  }

  /**
   * Compare-and-delete executed as a single critical section. Callers inside
   * the gate action use this directly (the lock is already held); everyone
   * else goes through #clearIf, which acquires the gate.
   */
  async #compareAndDelete(matches: (current: HostedOAuthCredential) => boolean): Promise<boolean> {
    const current = await this.#options.store.get(this.#options.key)
    if (current === null) return true
    if (!matches(current)) return false
    await this.#options.store.delete(this.#options.key)
    return true
  }

  /**
   * Gate-coordinated compare-and-delete. The in-process operation chain is
   * awaited first so the section can never race this manager's own rotation,
   * then the cross-process gate makes the get/delete pair atomic against
   * every other gate-respecting process.
   */
  async #clearIf(matches: (current: HostedOAuthCredential) => boolean): Promise<boolean> {
    const previous = this.#inflight
    if (previous !== null) await previous.promise.catch(() => undefined)
    const gate = this.#options.refreshGate
    if (gate === undefined) return this.#compareAndDelete(matches)
    return gate(() => this.#compareAndDelete(matches))
  }

  async #performRefresh(options: RefreshRequest): Promise<HostedOAuthCredential> {
    await this.#assertBinding(options.signal)
    // Re-read inside the gate so a concurrent coordinator can never be handed
    // a snapshot another process has already rotated.
    const current = await this.#options.store.get(this.#options.key)
    if (current === null) throw new LoginRequiredError()
    if (options.rejectedAccessToken === undefined) {
      // Snapshot-aware proactive path: a concurrent process may have already
      // rotated to a fresh generation while this caller waited for the gate.
      if (!this.#isExpiring(current)) {
        this.#assertScopes(current)
        return current
      }
    } else if (current.accessToken !== options.rejectedAccessToken) {
      // The 401 was for a token this store no longer holds; adopt the newer
      // generation instead of burning its refresh family.
      this.#assertScopes(current)
      return current
    }
    if (current.refreshToken === undefined) {
      // Only clear what was observed; a concurrent writer must never lose its
      // material to this decision.
      await this.#compareAndDelete((stored) => sameCredential(stored, current))
      throw new LoginRequiredError()
    }
    let pair: CliTokenPair
    try {
      pair = await this.#options.refresh({
        refreshToken: current.refreshToken,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      if (isLoginRequired(error)) {
        // Reuse/revocation killed the family the snapshot belongs to. Only
        // clear when the stored material is still this snapshot; a concurrent
        // actor that replaced it may have valid material of its own. This runs
        // inside the gate, so the comparison is directly atomic.
        await this.#compareAndDelete((stored) => sameCredential(stored, current))
        throw new LoginRequiredError()
      }
      throw error
    }
    // If another process already rotated the family away from the presented
    // refresh token, keep its material instead of overwriting it with a stale
    // response.
    const latest = await this.#options.store.get(this.#options.key)
    if (latest !== null && latest.refreshToken !== current.refreshToken) {
      this.#assertScopes(latest)
      return latest
    }
    const next = credentialFromTokenPair(pair, this.#options.clock.now())
    // Commit before the scope check: the family has already rotated, so the
    // new refresh token must be preserved even when the grant is unusable.
    await this.#options.store.set(this.#options.key, next)
    this.#assertScopes(next)
    await this.#options.onRefreshed?.(next)
    return next
  }
}

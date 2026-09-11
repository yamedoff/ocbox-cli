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

/**
 * Cross-process refresh coordinator. The in-process promise gate serializes
 * refreshes per object; hosts with a shared state directory inject a
 * bounded coordinator (e.g. the T3 exclusive file lock) so two CLI processes
 * can never present the same rotating refresh token to the server at once,
 * which would be classified as refresh reuse and could revoke the family.
 */
export type RefreshGate = <Result>(action: () => Promise<Result>) => Promise<Result>

/**
 * Issuance binding facts. When both parts are provided, a stored credential is
 * only usable when the machine-level metadata attests that it was minted by
 * the same configured issuer for the `cli` audience — staging or foreign-host
 * credentials cannot be replayed against another configured API.
 */
export interface CredentialBinding {
  readonly expectedIssuer: string
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

/**
 * Sole reader/writer of bearer material. It enforces origin/audience/scope
 * binding, serializes concurrent refreshes (in-process, and across processes
 * through the injected refresh gate), and clears local material on
 * reuse/revocation so callers see a typed login error — but never deletes
 * material that a concurrent actor already replaced.
 */
export class HostedTokenManager {
  readonly #options: HostedTokenManagerOptions
  #inflight: Promise<HostedOAuthCredential> | null = null

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
   * replaced it — the caller must not destroy newer material.
   */
  async clearIfToken(token: string): Promise<boolean> {
    const current = await this.#options.store.get(this.#options.key)
    if (current === null) return true
    if (current.accessToken !== token) return false
    await this.#options.store.delete(this.#options.key)
    return true
  }

  /**
   * Deletes the stored credential only when it still matches the full snapshot
   * (access and refresh) used by a failed rotation, preserving anything a
   * concurrent process wrote in the meantime.
   */
  async clearIfCredential(snapshot: HostedOAuthCredential): Promise<boolean> {
    const current = await this.#options.store.get(this.#options.key)
    if (current === null) return true
    if (
      current.accessToken !== snapshot.accessToken ||
      current.refreshToken !== snapshot.refreshToken
    ) {
      return false
    }
    await this.#options.store.delete(this.#options.key)
    return true
  }

  async getValidCredential(signal?: AbortSignal): Promise<HostedOAuthCredential> {
    await this.#assertBinding()
    const credential = await this.#options.store.get(this.#options.key)
    if (credential === null) throw new LoginRequiredError()
    this.#assertScopes(credential)
    return this.#isExpiring(credential) ? this.refresh(signal) : credential
  }

  refresh(signal?: AbortSignal): Promise<HostedOAuthCredential> {
    if (this.#inflight !== null) return this.#inflight
    const gate: RefreshGate = (action) => {
      if (this.#options.refreshGate !== undefined) {
        return this.#options.refreshGate(action)
      }
      return action()
    }
    this.#inflight = gate(() => this.#performRefresh(signal)).finally(() => {
      this.#inflight = null
    })
    return this.#inflight
  }

  async #assertBinding(): Promise<void> {
    const binding = this.#options.binding
    if (binding === undefined) return
    const metadata = await binding.metadataRepository.load()
    if (metadata === null) {
      throw new AuthBindingError(
        undefined,
        'No login metadata attests this credential; run `ocbox auth login`',
      )
    }
    if (metadata.audience !== 'cli' || metadata.issuer !== binding.expectedIssuer) {
      // Error messages cannot carry URLs/hosts (redaction-controlled), so the
      // issuance origin is not echoed back; the operator identifies it by rerun.
      throw new AuthBindingError(
        undefined,
        'The stored credential was minted by a different hosted API; ' +
          'run `ocbox auth logout` then `ocbox auth login` with the matching --api-url',
      )
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

  async #performRefresh(signal?: AbortSignal): Promise<HostedOAuthCredential> {
    await this.#assertBinding()
    // Re-read inside the gate so a concurrent coordinator can never be handed
    // a snapshot another process has already rotated.
    const current = await this.#options.store.get(this.#options.key)
    if (current === null || current.refreshToken === undefined) {
      await this.clear()
      throw new LoginRequiredError()
    }
    let pair: CliTokenPair
    try {
      pair = await this.#options.refresh({
        refreshToken: current.refreshToken,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (isLoginRequired(error)) {
        // Reuse/revocation killed the family the snapshot belongs to. Only
        // clear when the stored material is still this snapshot; a concurrent
        // actor that replaced it may have valid material of its own.
        await this.clearIfCredential(current)
        throw new LoginRequiredError()
      }
      throw error
    }
    // If another process already rotated the family away from the presented
    // refresh token, keep its material instead of overwriting it with a stale
    // response.
    const latest = await this.#options.store.get(this.#options.key)
    if (latest !== null && latest.refreshToken !== current.refreshToken) return latest
    const next = credentialFromTokenPair(pair, this.#options.clock.now())
    await this.#options.store.set(this.#options.key, next)
    await this.#options.onRefreshed?.(next)
    return next
  }
}

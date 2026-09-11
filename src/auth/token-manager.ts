import {
  type CredentialStore,
  type HostedOAuthCredential,
  type HostedOAuthCredentialKey,
  HostedOAuthCredentialSchema,
} from '../credentials/store.js'
import type { ClockPort } from './clock.js'
import { AuthBindingError, isLoginRequired, LoginRequiredError } from './errors.js'
import type { CliTokenPair } from './oauth-client.js'

export interface TokenRefreshInput {
  readonly refreshToken: string
  readonly signal?: AbortSignal | undefined
}

export type TokenRefresh = (input: TokenRefreshInput) => Promise<CliTokenPair>

export interface HostedTokenManagerOptions {
  readonly store: CredentialStore
  readonly key: HostedOAuthCredentialKey
  readonly clock: ClockPort
  readonly refresh: TokenRefresh
  readonly expirySkewMilliseconds: number
  readonly requiredScopes?: readonly string[]
  readonly onRefreshed?: (credential: HostedOAuthCredential) => Promise<void> | void
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
 * Sole reader/writer of bearer material. It enforces expiry skew and scope
 * binding, serializes concurrent refreshes into one in-flight rotation, and
 * clears local material on reuse/revocation so callers see a typed login error.
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

  async getValidCredential(signal?: AbortSignal): Promise<HostedOAuthCredential> {
    const credential = await this.#options.store.get(this.#options.key)
    if (credential === null) throw new LoginRequiredError()
    this.#assertBinding(credential)
    return this.#isExpiring(credential) ? this.refresh(signal) : credential
  }

  refresh(signal?: AbortSignal): Promise<HostedOAuthCredential> {
    if (this.#inflight !== null) return this.#inflight
    this.#inflight = this.#performRefresh(signal).finally(() => {
      this.#inflight = null
    })
    return this.#inflight
  }

  #assertBinding(credential: HostedOAuthCredential): void {
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
        await this.clear()
        throw new LoginRequiredError()
      }
      throw error
    }
    // If another writer already rotated the refresh family, keep that material
    // instead of overwriting it with a stale response.
    const latest = await this.#options.store.get(this.#options.key)
    if (latest !== null && latest.refreshToken !== current.refreshToken) return latest
    const next = credentialFromTokenPair(pair, this.#options.clock.now())
    await this.#options.store.set(this.#options.key, next)
    await this.#options.onRefreshed?.(next)
    return next
  }
}

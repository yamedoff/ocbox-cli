import { z } from 'zod'
import { UtcTimestampSchema } from '../domain/timestamps.js'

const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,255}$/

/** Hosted OAuth is the only credential class accepted by this port. */
export const HostedOAuthCredentialKeySchema = z.strictObject({
  kind: z.literal('hosted-oauth'),
  provider: z.string().regex(PROVIDER_NAME_PATTERN),
  accountId: z.string().regex(ACCOUNT_ID_PATTERN),
})

export const HostedOAuthCredentialSchema = z.strictObject({
  tokenType: z.literal('Bearer'),
  accessToken: z.string().min(1).max(16_384),
  refreshToken: z.string().min(1).max(16_384).optional(),
  expiresAt: UtcTimestampSchema.nullable(),
  scopes: z.array(z.string().min(1).max(256)).max(256).readonly(),
})

export type HostedOAuthCredentialKey = z.infer<typeof HostedOAuthCredentialKeySchema>
export type HostedOAuthCredential = z.infer<typeof HostedOAuthCredentialSchema>

export interface CredentialStore {
  get(key: HostedOAuthCredentialKey): Promise<HostedOAuthCredential | null>
  set(key: HostedOAuthCredentialKey, credential: HostedOAuthCredential): Promise<void>
  delete(key: HostedOAuthCredentialKey): Promise<void>
}

/** Boundary implemented by Keychain, Credential Manager, or Secret Service adapters. */
export interface OsCredentialAdapter extends CredentialStore {
  readonly available: boolean
}

/**
 * Uses an OS credential adapter when available. Adapter errors are propagated;
 * fallback is never attempted after an OS-store failure because that could
 * silently downgrade protection.
 */
export class HostedOAuthCredentialStore implements CredentialStore {
  readonly #osAdapter: OsCredentialAdapter
  readonly #protectedFileFallback: CredentialStore

  constructor(osAdapter: OsCredentialAdapter, protectedFileFallback: CredentialStore) {
    this.#osAdapter = osAdapter
    this.#protectedFileFallback = protectedFileFallback
  }

  get(key: HostedOAuthCredentialKey): Promise<HostedOAuthCredential | null> {
    return this.#selected().get(HostedOAuthCredentialKeySchema.parse(key))
  }

  set(key: HostedOAuthCredentialKey, credential: HostedOAuthCredential): Promise<void> {
    return this.#selected().set(
      HostedOAuthCredentialKeySchema.parse(key),
      HostedOAuthCredentialSchema.parse(credential),
    )
  }

  delete(key: HostedOAuthCredentialKey): Promise<void> {
    return this.#selected().delete(HostedOAuthCredentialKeySchema.parse(key))
  }

  #selected(): CredentialStore {
    return this.#osAdapter.available ? this.#osAdapter : this.#protectedFileFallback
  }
}

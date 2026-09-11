import { rm } from 'node:fs/promises'
import { z } from 'zod'
import { HostedOAuthCredentialKeySchema } from '../credentials/store.js'
import { UtcTimestampSchema } from '../domain/timestamps.js'
import { AtomicJsonStore, type AtomicJsonStoreOptions } from '../lifecycle/atomic-json-store.js'
import { findSensitiveMaterial } from '../security/redaction.js'

/**
 * Non-secret hosted-auth metadata. It may retain only the credential
 * reference plus expiry/scope/audience facts; never a token, code, or verifier.
 */
export const AuthMetadataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  issuer: z.string().min(1).max(512),
  clientId: z.string().min(1).max(128),
  audience: z.literal('cli'),
  scopes: z.array(z.string().min(1).max(256)).max(256).readonly(),
  expiresAt: UtcTimestampSchema.nullable(),
  identity: HostedOAuthCredentialKeySchema,
  updatedAt: UtcTimestampSchema,
})

export type AuthMetadata = z.infer<typeof AuthMetadataSchema>

/** Injectable metadata boundary so login/status/logout orchestration stays testable. */
export interface AuthMetadataRepository {
  load(signal?: AbortSignal): Promise<AuthMetadata | null>
  save(metadata: AuthMetadata, signal?: AbortSignal): Promise<void>
  clear(): Promise<void>
}

export class UnsafeAuthMetadataError extends Error {
  constructor() {
    super('Auth metadata contains material that cannot be persisted')
    this.name = 'UnsafeAuthMetadataError'
  }
}

function assertSafe(metadata: AuthMetadata): AuthMetadata {
  if (findSensitiveMaterial(metadata).length > 0) throw new UnsafeAuthMetadataError()
  return metadata
}

/** Atomic, lock-protected store for the machine-level hosted-auth metadata. */
export class AuthMetadataStore implements AuthMetadataRepository {
  readonly #path: string
  readonly #store: AtomicJsonStore<AuthMetadata>

  constructor(path: string, options: AtomicJsonStoreOptions = {}) {
    this.#path = path
    this.#store = new AtomicJsonStore(path, AuthMetadataSchema, options)
  }

  async load(signal?: AbortSignal): Promise<AuthMetadata | null> {
    const metadata = await this.#store.load(signal)
    return metadata === null ? null : assertSafe(metadata)
  }

  async save(metadata: AuthMetadata, signal?: AbortSignal): Promise<void> {
    const parsed = assertSafe(AuthMetadataSchema.parse(metadata))
    await this.#store.update(
      () => parsed,
      () => parsed,
      signal,
    )
  }

  async clear(): Promise<void> {
    await rm(this.#path, { force: true })
  }
}

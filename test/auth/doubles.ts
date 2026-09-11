import type { AuthMetadata, AuthMetadataRepository } from '../../src/auth/metadata.js'
import type { CliTokenPair } from '../../src/auth/oauth-client.js'
import type {
  CredentialStore,
  HostedOAuthCredential,
  HostedOAuthCredentialKey,
} from '../../src/credentials/index.js'

export const TEST_KEY: HostedOAuthCredentialKey = {
  accountId: 'default',
  kind: 'hosted-oauth',
  provider: 'ocbox',
}
export const TEST_NOW = Date.parse('2026-09-11T12:00:00.000Z')

export class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, HostedOAuthCredential>()
  readonly sets: HostedOAuthCredential[] = []
  readonly deletes: HostedOAuthCredentialKey[] = []

  static key(key: HostedOAuthCredentialKey): string {
    return `${key.kind}|${key.provider}|${key.accountId}`
  }

  get(key: HostedOAuthCredentialKey): Promise<HostedOAuthCredential | null> {
    return Promise.resolve(this.values.get(MemoryCredentialStore.key(key)) ?? null)
  }

  set(key: HostedOAuthCredentialKey, credential: HostedOAuthCredential): Promise<void> {
    this.values.set(MemoryCredentialStore.key(key), credential)
    this.sets.push(credential)
    return Promise.resolve()
  }

  delete(key: HostedOAuthCredentialKey): Promise<void> {
    this.values.delete(MemoryCredentialStore.key(key))
    this.deletes.push(key)
    return Promise.resolve()
  }
}

export class MemoryMetadataRepository implements AuthMetadataRepository {
  value: AuthMetadata | null = null
  readonly saves: AuthMetadata[] = []

  load(): Promise<AuthMetadata | null> {
    return Promise.resolve(this.value)
  }

  save(metadata: AuthMetadata): Promise<void> {
    this.value = metadata
    this.saves.push(metadata)
    return Promise.resolve()
  }

  clear(): Promise<void> {
    this.value = null
    return Promise.resolve()
  }
}

export function tokenPair(suffix: string, expiresIn = 900): CliTokenPair {
  const char = suffix.slice(0, 1)
  const refresh = char.toUpperCase()
  return {
    accessToken: char.repeat(48),
    expiresIn,
    refreshToken: refresh.repeat(48),
    scope: 'source:read',
    tokenType: 'Bearer',
  }
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}

export const fixedClock = (now: number): { now: () => number } => ({ now: () => now })

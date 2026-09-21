import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import {
  HostedOAuthCredentialKeySchema,
  HostedOAuthCredentialSchema,
  type CredentialStore,
  type HostedOAuthCredential,
  type HostedOAuthCredentialKey,
} from './store.js'
import { PowerShellWindowsAclProtector, type WindowsAclProtector } from './windows-acl.js'

const CredentialFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  key: HostedOAuthCredentialKeySchema,
  credential: HostedOAuthCredentialSchema,
})

export interface ProtectedFileCredentialStoreOptions {
  readonly platform?: 'win32' | 'unix'
  readonly windowsAclProtector?: WindowsAclProtector
  readonly createNonce?: () => string
}

export class CredentialProtectionError extends Error {
  constructor() {
    super('Credential storage permissions could not be protected and verified')
    this.name = 'CredentialProtectionError'
  }
}

export class CredentialFileCorruptionError extends Error {
  constructor() {
    super('Stored hosted OAuth credential is invalid')
    this.name = 'CredentialFileCorruptionError'
  }
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined
}

function credentialFileName(key: HostedOAuthCredentialKey): string {
  const canonical = `${key.kind}\0${key.provider}\0${key.accountId}`
  return `${createHash('sha256').update(canonical).digest('hex')}.json`
}

/**
 * Protected-file fallback for hosted OAuth only. Unix permissions are verified
 * as 0600/0700; Windows ACL application and current-user-only verification are
 * mandatory before any credential is committed or read.
 */
export class ProtectedFileCredentialStore implements CredentialStore {
  readonly #directory: string
  readonly #platform: 'win32' | 'unix'
  readonly #windowsAcl: WindowsAclProtector
  readonly #createNonce: () => string

  constructor(directory: string, options: ProtectedFileCredentialStoreOptions = {}) {
    if (!isAbsolute(directory)) throw new TypeError('Credential directory must be absolute')
    this.#directory = directory
    this.#platform = options.platform ?? (process.platform === 'win32' ? 'win32' : 'unix')
    this.#windowsAcl = options.windowsAclProtector ?? new PowerShellWindowsAclProtector()
    this.#createNonce = options.createNonce ?? randomUUID
  }

  async get(key: HostedOAuthCredentialKey): Promise<HostedOAuthCredential | null> {
    const parsedKey = HostedOAuthCredentialKeySchema.parse(key)
    await this.#ensureProtectedDirectory()
    const path = join(this.#directory, credentialFileName(parsedKey))
    try {
      await this.#verifyProtectedPath(path, 'file')
      const candidate: unknown = JSON.parse(await readFile(path, 'utf8'))
      const parsed = CredentialFileSchema.parse(candidate)
      if (
        parsed.key.kind !== parsedKey.kind ||
        parsed.key.provider !== parsedKey.provider ||
        parsed.key.accountId !== parsedKey.accountId
      ) {
        throw new CredentialFileCorruptionError()
      }
      return parsed.credential
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null
      if (error instanceof CredentialProtectionError) throw error
      throw new CredentialFileCorruptionError()
    }
  }

  async set(key: HostedOAuthCredentialKey, credential: HostedOAuthCredential): Promise<void> {
    const parsedKey = HostedOAuthCredentialKeySchema.parse(key)
    const parsedCredential = HostedOAuthCredentialSchema.parse(credential)
    await this.#ensureProtectedDirectory()
    const destination = join(this.#directory, credentialFileName(parsedKey))
    const temporary = `${destination}.tmp.${this.#createNonce()}`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let committed = false
    try {
      handle = await open(temporary, 'wx', 0o600)
      // Verify protection on the empty file before any credential bytes are written.
      await this.#protectAndVerify(temporary, 'file')
      await handle.writeFile(
        `${JSON.stringify({ schemaVersion: 1, key: parsedKey, credential: parsedCredential })}\n`,
        'utf8',
      )
      await handle.sync()
      await handle.close()
      handle = undefined
      await this.#protectAndVerify(temporary, 'file')
      await rename(temporary, destination)
      committed = true
      await this.#verifyProtectedPath(destination, 'file')
    } catch (error) {
      await handle?.close()
      await rm(temporary, { force: true })
      if (committed && error instanceof CredentialProtectionError) {
        await rm(destination, { force: true })
      }
      throw error
    }
  }

  async delete(key: HostedOAuthCredentialKey): Promise<void> {
    const parsedKey = HostedOAuthCredentialKeySchema.parse(key)
    const path = join(this.#directory, credentialFileName(parsedKey))
    try {
      await unlink(path)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }

  async #ensureProtectedDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    await this.#protectAndVerify(this.#directory, 'directory')
  }

  async #protectAndVerify(path: string, kind: 'directory' | 'file'): Promise<void> {
    const metadata = await lstat(path)
    if (
      metadata.isSymbolicLink() ||
      (kind === 'directory' ? !metadata.isDirectory() : !metadata.isFile())
    ) {
      throw new CredentialProtectionError()
    }
    if (this.#platform === 'win32') {
      if (!(await this.#windowsAcl.protectAndVerify(path, kind))) {
        throw new CredentialProtectionError()
      }
      return
    }
    await chmod(path, kind === 'directory' ? 0o700 : 0o600)
    await this.#verifyProtectedPath(path, kind)
  }

  async #verifyProtectedPath(path: string, kind: 'directory' | 'file'): Promise<void> {
    const metadata = await lstat(path)
    if (
      metadata.isSymbolicLink() ||
      (kind === 'directory' ? !metadata.isDirectory() : !metadata.isFile())
    ) {
      throw new CredentialProtectionError()
    }
    if (this.#platform === 'win32') {
      if (!(await this.#windowsAcl.protectAndVerify(path, kind))) {
        throw new CredentialProtectionError()
      }
      return
    }
    const expectedMode = kind === 'directory' ? 0o700 : 0o600
    if (metadata.isSymbolicLink() || (metadata.mode & 0o777) !== expectedMode) {
      throw new CredentialProtectionError()
    }
    if (kind === 'file' && !metadata.isFile()) throw new CredentialProtectionError()
    if (kind === 'directory' && !metadata.isDirectory()) throw new CredentialProtectionError()
  }
}

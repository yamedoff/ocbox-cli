import { lstat, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CredentialProtectionError,
  HostedOAuthCredentialStore,
  ProtectedFileCredentialStore,
  type CredentialStore,
  type HostedOAuthCredential,
  type HostedOAuthCredentialKey,
  type OsCredentialAdapter,
  type ProtectedPathKind,
  type WindowsAclProtector,
} from '../../src/credentials/index.js'

const temporaryDirectories: string[] = []
const KEY: HostedOAuthCredentialKey = {
  kind: 'hosted-oauth',
  provider: 'opencloudbox',
  accountId: 'account-1',
}
const CREDENTIAL: HostedOAuthCredential = {
  tokenType: 'Bearer',
  accessToken: 'opaque-access-value',
  refreshToken: 'opaque-refresh-value',
  expiresAt: '2026-09-05T12:00:00.000Z' as HostedOAuthCredential['expiresAt'],
  scopes: ['sandboxes:write'],
}

async function temporaryDirectory(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  const directory = await mkdtemp(join(tmpdir(), 'ocbox-credentials-'))
  temporaryDirectories.push(directory)
  return directory
}

class SequenceAclProtector implements WindowsAclProtector {
  readonly calls: Array<{ path: string; kind: ProtectedPathKind }> = []
  readonly #results: boolean[]

  constructor(results: boolean[]) {
    this.#results = results
  }

  protectAndVerify(path: string, kind: ProtectedPathKind): Promise<boolean> {
    this.calls.push({ path, kind })
    return Promise.resolve(this.#results.shift() ?? true)
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('credential stores', () => {
  it.runIf(process.platform === 'win32')(
    'round-trips through real Windows ACL protection',
    async () => {
      const directory = join(await temporaryDirectory(), "spaces & 'quoted' directory")
      const store = new ProtectedFileCredentialStore(directory)
      await store.set(KEY, CREDENTIAL)
      expect(await store.get(KEY)).toEqual(CREDENTIAL)
      await store.delete(KEY)
      expect(await store.get(KEY)).toBeNull()
    },
    30_000,
  )

  it('round-trips hosted OAuth through a verified protected-file fallback', async () => {
    const directory = await temporaryDirectory()
    const acl = new SequenceAclProtector([])
    const store = new ProtectedFileCredentialStore(directory, {
      platform: 'win32',
      windowsAclProtector: acl,
    })

    await store.set(KEY, CREDENTIAL)
    expect(await store.get(KEY)).toEqual(CREDENTIAL)
    expect((await readdir(directory)).filter((name) => name.endsWith('.json'))).toHaveLength(1)
    expect(acl.calls.some((call) => call.kind === 'file')).toBe(true)
  })

  it('fails closed and removes temporary material when permission verification fails', async () => {
    const directory = await temporaryDirectory()
    const acl = new SequenceAclProtector([true, false])
    const store = new ProtectedFileCredentialStore(directory, {
      platform: 'win32',
      windowsAclProtector: acl,
    })

    await expect(store.set(KEY, CREDENTIAL)).rejects.toBeInstanceOf(CredentialProtectionError)
    expect(await readdir(directory)).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('enforces Unix 0700/0600 modes', async () => {
    const directory = await temporaryDirectory()
    const store = new ProtectedFileCredentialStore(directory, { platform: 'unix' })
    await store.set(KEY, CREDENTIAL)

    const [fileName] = await readdir(directory)
    expect((await lstat(directory)).mode & 0o777).toBe(0o700)
    expect((await lstat(join(directory, fileName ?? 'missing'))).mode & 0o777).toBe(0o600)
  })

  it('uses the OS adapter when available and never silently downgrades after failure', async () => {
    let fallbackCalls = 0
    const fallback: CredentialStore = {
      get: async () => {
        fallbackCalls += 1
        return null
      },
      set: async () => {
        fallbackCalls += 1
      },
      delete: async () => {
        fallbackCalls += 1
      },
    }
    const osAdapter: OsCredentialAdapter = {
      available: true,
      get: async () => {
        throw new Error('OS store unavailable')
      },
      set: async () => {
        throw new Error('OS store unavailable')
      },
      delete: async () => {
        throw new Error('OS store unavailable')
      },
    }
    const store = new HostedOAuthCredentialStore(osAdapter, fallback)

    await expect(store.get(KEY)).rejects.toThrow('OS store unavailable')
    expect(fallbackCalls).toBe(0)
  })
})

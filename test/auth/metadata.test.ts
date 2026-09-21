import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthMetadataStore } from '../../src/auth/metadata.js'
import { AuthMetadataSchema } from '../../src/auth/metadata.js'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ocbox-auth-metadata-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

function metadata(issuer = 'https://api.example.test') {
  return AuthMetadataSchema.parse({
    audience: 'cli',
    clientId: 'ocb_cli',
    expiresAt: null,
    identity: { accountId: 'default', kind: 'hosted-oauth', provider: 'ocbox' },
    issuer,
    schemaVersion: 1,
    scopes: ['source:read'],
    updatedAt: '2026-09-11T12:00:00.000Z',
  })
}

describe('AuthMetadataStore', () => {
  it('saves, loads, and round-trips metadata without secret material', async () => {
    const store = new AuthMetadataStore(join(await temporaryDirectory(), 'auth.json'))
    await expect(store.load()).resolves.toBeNull()
    await store.save(metadata())
    await expect(store.load()).resolves.toMatchObject({ issuer: 'https://api.example.test' })
    await store.clear()
    await expect(store.load()).resolves.toBeNull()
  })

  it('reports cleared only after absence is confirmed, and is idempotent', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'auth.json')
    const store = new AuthMetadataStore(path)
    await store.save(metadata())
    await store.clear()
    // Absence is confirmed: a subsequent load sees no metadata, and a second
    // clear on a missing file is a no-op success rather than a swallowed
    // Windows sharing violation.
    await expect(store.load()).resolves.toBeNull()
    await expect(store.clear()).resolves.toBeUndefined()
    await expect(store.load()).resolves.toBeNull()
  })

  it('ignores a stale temporary file when confirming cleared state', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'auth.json')
    await writeFile(`${path}.tmp.1234.nonce`, 'garbage', 'utf8')
    const store = new AuthMetadataStore(path)
    await expect(store.clear()).resolves.toBeUndefined()
    await expect(store.load()).resolves.toBeNull()
  })

  it('rejects metadata containing sensitive material on save', async () => {
    const store = new AuthMetadataStore(join(await temporaryDirectory(), 'auth.json'))
    const unsafe = { ...metadata(), issuer: 'https://x.test' } as { issuer: string }
    unsafe.issuer = 'password=supersecret'
    await expect(store.save(AuthMetadataSchema.parse(unsafe))).rejects.toBeTruthy()
  })
})

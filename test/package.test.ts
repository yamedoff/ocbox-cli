import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

interface PackageMetadata {
  bin: {
    ocbox: string
    opencloudbox: string
  }
  name: string
  private: boolean
  version: string
}

async function readPackageMetadata(): Promise<PackageMetadata> {
  const packageJsonUrl = new URL('../package.json', import.meta.url)
  return JSON.parse(await readFile(packageJsonUrl, 'utf8')) as PackageMetadata
}

describe('package identity', () => {
  it('keeps the locked package name and version private', async () => {
    const metadata = await readPackageMetadata()

    expect(metadata.name).toBe('opencloudbox')
    expect(metadata.version).toBe('0.1.0')
    expect(metadata.private).toBe(true)
  })

  it('maps both approved binary names to one entrypoint', async () => {
    const metadata = await readPackageMetadata()

    expect(metadata.bin.ocbox).toBe('./dist/index.js')
    expect(metadata.bin.opencloudbox).toBe(metadata.bin.ocbox)
  })
})

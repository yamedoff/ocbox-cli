import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

interface PackageMetadata {
  bin: {
    ocbox: string
    'ocbox-execution-helper': string
    opencloudbox: string
  }
  engines: { node: string }
  files: string[]
  name: string
  private?: boolean
  publishConfig: { access: string; provenance: boolean }
  scripts: { prepublishOnly: string }
  version: string
}

async function readPackageMetadata(): Promise<PackageMetadata> {
  const packageJsonUrl = new URL('../package.json', import.meta.url)
  return JSON.parse(await readFile(packageJsonUrl, 'utf8')) as PackageMetadata
}

describe('package identity', () => {
  it('publishes the locked package name and version with the required packaging gate', async () => {
    const metadata = await readPackageMetadata()

    expect(metadata.name).toBe('opencloudbox')
    expect(metadata.version).toBe('0.1.0')
    expect(metadata).not.toHaveProperty('private')
    expect(metadata.engines).toEqual({ node: '>=22' })
    expect(metadata.scripts.prepublishOnly).toBe(
      'pnpm run build && pnpm run typecheck && pnpm run test:unit',
    )
    expect(metadata.publishConfig).toEqual({ access: 'public', provenance: true })
    expect(metadata.files).toEqual(['dist/**/*.js', 'dist/**/*.d.ts', 'oclif.manifest.json'])
  })

  it('maps both approved binary names to one entrypoint', async () => {
    const metadata = await readPackageMetadata()

    expect(metadata.bin.ocbox).toBe('./dist/index.js')
    expect(metadata.bin.opencloudbox).toBe(metadata.bin.ocbox)
    expect(metadata.bin['ocbox-execution-helper']).toBe('./dist/execution-helper.js')
  })
})

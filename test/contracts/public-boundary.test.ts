import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as contracts from '../../src/contracts.js'

interface PackageMetadata {
  dependencies: Readonly<Record<string, string>>
  exports: {
    './contracts': { import: string; types: string }
  }
  private: boolean
}

async function collectTypeScriptFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return collectTypeScriptFiles(path)
      return extname(entry.name) === '.ts' ? [path] : []
    }),
  )
  return nested.flat()
}

describe('public contract boundary', () => {
  it('matches the committed runtime API manifest', async () => {
    const manifestUrl = new URL('../fixtures/contracts/public-api.json', import.meta.url)
    const manifest = JSON.parse(await readFile(manifestUrl, 'utf8')) as readonly string[]
    expect(Object.keys(contracts).sort()).toEqual(manifest)
  })

  it('publishes contracts through a deterministic side-effect-free package export', async () => {
    const packageUrl = new URL('../../package.json', import.meta.url)
    const metadata = JSON.parse(await readFile(packageUrl, 'utf8')) as PackageMetadata
    expect(metadata.private).toBe(true)
    expect(metadata.exports['./contracts']).toEqual({
      types: './dist/contracts.d.ts',
      import: './dist/contracts.js',
    })

    const contractsSource = await readFile(
      new URL('../../src/contracts.ts', import.meta.url),
      'utf8',
    )
    expect(contractsSource).not.toContain("'./index.js'")
    expect(contractsSource).not.toContain('@oclif/core')
  })

  it('contains no provider SDK import or dependency in contract modules', async () => {
    const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
    const contractDirectories = [
      join(repositoryRoot, 'src', 'domain'),
      join(repositoryRoot, 'src', 'providers', 'contract'),
      join(repositoryRoot, 'src', 'errors'),
    ]
    const files = (await Promise.all(contractDirectories.map(collectTypeScriptFiles))).flat()
    const forbiddenImport = /from\s+['"](?:@?daytona|@?e2b|[^'"]*provider-sdk)[^'"]*['"]/i

    for (const path of files) {
      expect(await readFile(path, 'utf8'), path).not.toMatch(forbiddenImport)
    }

    const packageUrl = new URL('../../package.json', import.meta.url)
    const metadata = JSON.parse(await readFile(packageUrl, 'utf8')) as PackageMetadata
    expect(Object.keys(metadata.dependencies)).toEqual(['@oclif/core', 'zod'])
  })
})

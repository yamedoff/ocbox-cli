import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CHECKSUM_FILE_NAME,
  LATEST_RELEASE_API_URL,
  RELEASE_BASE_URL,
  releaseTarballName,
} from '../../src/release/source.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

describe('release source of truth', () => {
  it('names the tarball exactly as pack-release does', () => {
    expect(releaseTarballName('0.2.0')).toBe('ocbox-0.2.0.tgz')
  })

  it('keeps the install scripts on the same release URL, API, and checksum name', async () => {
    const shell = await readFile(join(repoRoot, 'install.sh'), 'utf8')
    const powerShell = await readFile(join(repoRoot, 'install.ps1'), 'utf8')

    expect(shell).toContain(`DEFAULT_RELEASE_BASE="${RELEASE_BASE_URL}"`)
    expect(shell).toContain(`LATEST_RELEASE_API="${LATEST_RELEASE_API_URL}"`)
    expect(shell).toContain(`"${CHECKSUM_FILE_NAME}"`)
    expect(powerShell).toContain(`$DefaultReleaseBase = '${RELEASE_BASE_URL}'`)
    expect(powerShell).toContain(`$LatestReleaseApi = '${LATEST_RELEASE_API_URL}'`)
    expect(powerShell).toContain(`'${CHECKSUM_FILE_NAME}'`)
  })
})

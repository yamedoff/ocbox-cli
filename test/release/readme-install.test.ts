import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CHECKSUM_FILE_NAME,
  RELEASE_BASE_URL,
  releaseTarballName,
} from '../../src/release/source.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

interface PackageJson {
  name: string
  version: string
  private?: boolean
  scripts: Record<string, string>
  publishConfig?: {
    access?: string
    provenance?: boolean
  }
}

async function readRepoFile(...segments: string[]): Promise<string> {
  return readFile(join(repoRoot, ...segments), 'utf8')
}

/** The text from `## <title>` up to (but not including) the next level-two heading. */
function section(readme: string, title: string): string {
  const heading = new RegExp(`^## ${title}$`, 'm').exec(readme)
  if (heading === null) {
    throw new Error(`README.md has no "## ${title}" section`)
  }
  const start = heading.index + heading[0].length
  const end = readme.indexOf('\n## ', start)
  return readme.slice(start, end === -1 ? undefined : end)
}

function githubOwnerAndRepo(): { owner: string; repo: string } {
  const [owner, repo] = new URL(RELEASE_BASE_URL).pathname.split('/').filter(Boolean)
  if (owner === undefined || repo === undefined) {
    throw new Error(`Cannot derive owner/repo from ${RELEASE_BASE_URL}`)
  }
  return { owner, repo }
}

describe('README install path', () => {
  it('documents one source install path built from the release constants', async () => {
    const readme = await readRepoFile('README.md')
    const install = section(readme, 'Install')
    const pkg = JSON.parse(await readRepoFile('package.json')) as PackageJson
    const { owner, repo } = githubOwnerAndRepo()

    expect(install).toContain(`https://github.com/${owner}/${repo}.git`)
    expect(install).toContain('pnpm install --frozen-lockfile')
    expect(install).toContain('pnpm run pack:release')
    expect(install).toContain('OCBOX_RELEASE_BASE')
    expect(install).toContain('dist/release')
    expect(install).toContain('install.sh')
    expect(install).toContain('install.ps1')
    expect(install).toContain(releaseTarballName(pkg.version))
    expect(install).toContain(CHECKSUM_FILE_NAME)
    expect(install).toContain('LATEST')

    expect(install).not.toContain('raw.githubusercontent.com')
    expect(install).not.toContain(RELEASE_BASE_URL)

    expect(await readRepoFile('install.sh')).toContain('OCBOX_RELEASE_BASE')
    expect(await readRepoFile('install.ps1')).toContain('OCBOX_RELEASE_BASE')
    expect(await readRepoFile('scripts', 'pack-release.mjs')).toContain(
      "join(root, 'dist', 'release')",
    )
    expect(pkg.scripts['pack:release']).toContain('scripts/pack-release.mjs')
  })

  it('states the publication state without an npm-registry install command', async () => {
    const readme = await readRepoFile('README.md')
    const install = section(readme, 'Install')
    const pkg = JSON.parse(await readRepoFile('package.json')) as PackageJson

    expect(pkg.name).toBe('opencloudbox')
    expect(install).toContain(`${pkg.name}@${pkg.version}`)
    expect(readme).toMatch(/(?:not|isn't)\s+(?:yet\s+)?published|not\s+(?:yet\s+)?(?:on|to)\s+npm/i)
    expect(pkg.publishConfig?.access).toBe('public')
    expect(readme).toContain('publishConfig.access')
    expect(install).not.toMatch(/npm\s+(?:i|install)\s+-g\s+opencloudbox/)

    if (pkg.private === true) {
      expect(readme).toContain('private: true')
    } else {
      expect(readme).not.toContain('private: true')
    }
  })

  it('reads stored logs between exec and stop in the first-box journey', async () => {
    const readme = await readRepoFile('README.md')
    const execIndex = readme.indexOf('ocbox exec --timeout-seconds')
    const logsIndex = readme.indexOf('ocbox logs ')
    const stopIndex = readme.indexOf('ocbox stop')

    expect(execIndex).toBeGreaterThanOrEqual(0)
    expect(logsIndex).toBeGreaterThan(execIndex)
    expect(stopIndex).toBeGreaterThan(logsIndex)
    expect(readme).toMatch(/### \d+\. Read stored logs/)
  })
})

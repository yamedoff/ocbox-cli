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
  devEngines?: {
    runtime?: {
      name?: string
      version?: string
      onFail?: string
    }
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

/** A registry install of the CLI, which is not published and must not be offered. */
const REGISTRY_CLI_INSTALL =
  /\b(?:npm\s+(?:i|install)\s+(?:-g|--global)|pnpm\s+(?:add|install)\s+(?:-g|--global)|npx)\b[^\n]*\bopencloudbox\b/i

/** A `private` marker in any spelling a README might use for the package field. */
const PRIVATE_CLAIM = /(?:"private"|private)\s*:\s*true/i

describe('README install path', () => {
  it('documents one source install path built from the release constants', async () => {
    const readme = await readRepoFile('README.md')
    const install = section(readme, 'Install')
    const pkg = JSON.parse(await readRepoFile('package.json')) as PackageJson
    const { owner, repo } = githubOwnerAndRepo()

    expect(install).toContain(`https://github.com/${owner}/${repo}.git`)
    expect(install).toContain(`cd ${repo}`)
    expect(install).toContain('pnpm install --frozen-lockfile')
    expect(install).toContain('pnpm run pack:release')
    expect(install).toContain('OCBOX_RELEASE_BASE')
    expect(install).toContain('"$PWD/dist/release"')
    expect(install).toContain('"$PWD\\dist\\release"')
    expect(install).toContain('install.sh')
    expect(install).toContain('install.ps1')
    expect(install).toContain(releaseTarballName(pkg.version))
    expect(install).toContain(CHECKSUM_FILE_NAME)
    expect(install).toContain('LATEST')
    expect(install).toMatch(/only\s+working\s+install\s+path/i)

    const installIndex = install.indexOf('pnpm install --frozen-lockfile')
    const packIndex = install.indexOf('pnpm run pack:release')
    expect(installIndex).toBeGreaterThanOrEqual(0)
    expect(packIndex).toBeGreaterThan(installIndex)

    expect(install).not.toContain('raw.githubusercontent.com')
    expect(install).not.toContain(RELEASE_BASE_URL)
    expect(install).not.toMatch(REGISTRY_CLI_INSTALL)
    expect(install).not.toMatch(/\b(?:curl|wget|brew|irm)\b[^\n]*\b(?:install|ocbox)\b/i)

    expect(await readRepoFile('install.sh')).toContain('OCBOX_RELEASE_BASE')
    expect(await readRepoFile('install.ps1')).toContain('OCBOX_RELEASE_BASE')
    expect(await readRepoFile('scripts', 'pack-release.mjs')).toContain(
      "join(root, 'dist', 'release')",
    )
    expect(pkg.scripts['pack:release']).toContain('scripts/pack-release.mjs')
    expect(pkg.scripts['pack:release']).toContain('pnpm run build')
  })

  it('states the Node version the source install requires', async () => {
    const readme = await readRepoFile('README.md')
    const install = section(readme, 'Install')
    const toolchain = section(readme, 'Toolchain')
    const pkg = JSON.parse(await readRepoFile('package.json')) as PackageJson

    const nodeVersion = pkg.devEngines?.runtime?.version
    if (nodeVersion === undefined) {
      throw new Error('package.json has no devEngines.runtime.version')
    }
    expect(pkg.devEngines?.runtime?.onFail).toBe('error')

    expect(install).toContain(`Node.js ${nodeVersion}`)
    expect(install).not.toMatch(/Requires Node\.js\s*[≥>]/)
    expect(install).toContain('devEngines')
    expect(toolchain).toContain(`Node.js \`${nodeVersion}\``)
  })

  it('states the publication state without an npm-registry install command', async () => {
    const readme = await readRepoFile('README.md')
    const install = section(readme, 'Install')
    const pkg = JSON.parse(await readRepoFile('package.json')) as PackageJson

    expect(pkg.name).toBe('opencloudbox')
    expect(install).toContain(`${pkg.name}@${pkg.version}`)
    expect(install).toMatch(
      /\bnpm\b[^\n]*\b(?:not|isn't)\b[^\n]*\bpublished\b|\b(?:not|isn't)\b[^\n]*\b(?:on|to)\s+npm\b/i,
    )
    expect(pkg.publishConfig?.access).toBe('public')
    expect(install).toMatch(/publishConfig\.access[^\n]*\bis\b[^\n]*\bpublic\b/i)
    expect(readme).not.toMatch(REGISTRY_CLI_INSTALL)

    if (pkg.private === true) {
      expect(readme).toMatch(PRIVATE_CLAIM)
    } else {
      expect(readme).not.toMatch(PRIVATE_CLAIM)
    }
  })

  it('reads stored logs between exec and stop in the first-box journey', async () => {
    const readme = await readRepoFile('README.md')
    const journey = section(readme, 'Your first box')
    const execIndex = journey.indexOf('ocbox exec --timeout-seconds')
    const execOutput = /execution (exe_[a-z0-9]+) accepted/.exec(journey)
    const execId = execOutput?.[1]
    if (execId === undefined) {
      throw new Error('README.md first-box journey has no accepted execution ID')
    }
    const logsIndex = journey.indexOf(`ocbox logs ${execId}`)
    const stopIndex = journey.indexOf('ocbox stop')

    expect(execIndex).toBeGreaterThanOrEqual(0)
    expect(logsIndex).toBeGreaterThan(execIndex)
    expect(stopIndex).toBeGreaterThan(logsIndex)
    expect(journey).toMatch(/### \d+\. Read stored logs/)
  })
})

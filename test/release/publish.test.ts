import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readExpectedChecksum } from '../../src/release/release.js'
import {
  CHECKSUM_FILE_NAME,
  RELEASE_TARBALL_PREFIX,
  releaseTarballName,
} from '../../src/release/source.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const workflowPath = join(repoRoot, '.github', 'workflows', 'release.yml')

// Every test depends on the workflow: the beforeEach read makes a checkout
// without it fail each test instead of quietly skipping the checks.
let workflow = ''

const directories: string[] = []
const skipOnWindows = process.platform === 'win32'

beforeEach(async () => {
  workflow = await readFile(workflowPath, 'utf8')
})

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function indentation(line: string): number {
  return /^(\s*)/.exec(line)?.[1]?.length ?? 0
}

/** Lines belonging to one `- name:` step, stopping before the next step. */
function stepLines(workflowText: string, name: string): string[] {
  const lines = workflowText.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`)
  if (start === -1) throw new Error(`release.yml has no step named "${name}"`)
  const end = lines.findIndex((line, index) => index > start && /^\s*- name:/.test(line))
  return lines.slice(start, end === -1 ? lines.length : end)
}

function stepText(workflowText: string, name: string): string {
  return stepLines(workflowText, name).join('\n')
}

/** Body of the step's `run: |` block, dedented so bash can execute it. */
function runBlock(workflowText: string, name: string): string {
  const lines = stepLines(workflowText, name)
  const runIndex = lines.findIndex((line) => /^\s*run:\s*\|/.test(line))
  if (runIndex === -1) throw new Error(`step "${name}" has no run: | block`)
  const runIndent = indentation(lines[runIndex] ?? '')

  const body: string[] = []
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() === '') {
      body.push('')
      continue
    }
    if (indentation(line) <= runIndent) break
    body.push(line)
  }

  const nonBlank = body.filter((line) => line.trim() !== '')
  if (nonBlank.length === 0) throw new Error(`step "${name}" has an empty run: | block`)
  const base = Math.min(...nonBlank.map(indentation))
  return body.map((line) => line.slice(base)).join('\n')
}

async function makeTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

async function writePackageJson(root: string, version: string): Promise<void> {
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'opencloudbox', version }))
}

function commandOutput(result: {
  readonly stdout: string | Buffer | null
  readonly stderr: string | Buffer | null
}): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

/** package.json 1.2.3 plus the three assets scripts/pack-release.mjs writes. */
async function makeReleaseFixture(): Promise<string> {
  const version = '1.2.3'
  const root = await makeTempDir('ocbox-release-check-')
  await writePackageJson(root, version)

  const releaseDir = join(root, 'dist', 'release')
  await mkdir(releaseDir, { recursive: true })
  const bytes = Buffer.from('fixture release tarball bytes\n')
  const tarball = releaseTarballName(version)
  const digest = createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(releaseDir, tarball), bytes)
  await writeFile(join(releaseDir, CHECKSUM_FILE_NAME), `${digest}  ${tarball}\n`)
  await writeFile(join(releaseDir, 'LATEST'), `${version}\n`)
  return root
}

/** A real commit so the workflow can resolve a tag pointing at it. */
async function makeTaggedCommit(tag?: string): Promise<{ root: string; sha: string }> {
  const root = await makeTempDir('ocbox-release-resolve-')
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  await writePackageJson(root, '1.2.3')
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: root })
  if (tag !== undefined) execFileSync('git', ['tag', tag], { cwd: root })
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  return { root, sha }
}

describe('release workflow', () => {
  it('waits for the three-OS staging smoke run before it may publish', () => {
    expect(workflow).toMatch(
      /workflow_run:\s*\n\s+workflows:\s*\[\s*["']Release staging smoke["']\s*\]/,
    )
    expect(workflow).toMatch(/types:\s*\[\s*completed\s*\]/)
    expect(workflow).toMatch(/if:\s*github\.event\.workflow_run\.conclusion\s*==\s*'success'/)
    expect(workflow).toMatch(/ref:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/)
    // A direct tag trigger would race the smoke workflow instead of gating on it.
    expect(workflow).not.toMatch(/^\s*push:/m)
    expect(workflow).toContain('contents: write')
    expect(workflow).toContain('gh release create')

    const uses = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((match) =>
      String(match[1]),
    )
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) {
      expect(action, `${action} must be pinned to a 40-hex commit SHA`).toMatch(/@[0-9a-f]{40}$/)
    }
  })
})

describe('release workflow: tag matches package.json', () => {
  const script = () => runBlock(workflow, 'Require the tag to match package.json')

  it('resolves the tag from the smoke-tested commit, not the workflow ref', () => {
    const resolve = stepText(workflow, 'Resolve the release tag')
    expect(resolve).toMatch(/HEAD_SHA:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/)
    expect(resolve).toMatch(
      /HEAD_BRANCH:\s*\$\{\{\s*github\.event\.workflow_run\.head_branch\s*\}\}/,
    )
    expect(resolve).toContain("--list 'v*'")
    expect(stepText(workflow, 'Require the tag to match package.json')).toMatch(
      /RELEASE_TAG:\s*\$\{\{\s*steps\.tag\.outputs\.tag\s*\}\}/,
    )
  })

  it.skipIf(skipOnWindows)(
    'finds the v* tag on the smoke-tested commit when head_branch is empty',
    async () => {
      const { root, sha } = await makeTaggedCommit('v1.2.3')
      const output = join(root, 'github-output')
      await writeFile(output, '')

      const result = spawnSync(
        'bash',
        ['-e', '-c', runBlock(workflow, 'Resolve the release tag')],
        {
          cwd: root,
          env: { ...process.env, HEAD_SHA: sha, HEAD_BRANCH: '', GITHUB_OUTPUT: output },
          encoding: 'utf8',
        },
      )

      expect(result.status, commandOutput(result)).toBe(0)
      expect(await readFile(output, 'utf8')).toContain('tag=v1.2.3')
    },
  )

  it.skipIf(skipOnWindows)(
    'publishes nothing when the smoke-tested commit has no v* tag',
    async () => {
      const { root, sha } = await makeTaggedCommit()
      const output = join(root, 'github-output')
      await writeFile(output, '')

      const result = spawnSync(
        'bash',
        ['-e', '-c', runBlock(workflow, 'Resolve the release tag')],
        {
          cwd: root,
          env: { ...process.env, HEAD_SHA: sha, HEAD_BRANCH: 'main', GITHUB_OUTPUT: output },
          encoding: 'utf8',
        },
      )

      expect(result.status, commandOutput(result)).toBe(0)
      expect(await readFile(output, 'utf8')).toContain('tag=\n')
      expect(commandOutput(result)).toContain('nothing to publish')
    },
  )

  it.skipIf(skipOnWindows)('accepts v<version> from package.json', async () => {
    const root = await makeTempDir('ocbox-release-tag-')
    await writePackageJson(root, '1.2.3')

    const result = spawnSync('bash', ['-e', '-c', script()], {
      cwd: root,
      env: { ...process.env, RELEASE_TAG: 'v1.2.3' },
      encoding: 'utf8',
    })

    expect(result.status, commandOutput(result)).toBe(0)
  })

  it.skipIf(skipOnWindows)('rejects a tag that does not match the package version', async () => {
    const root = await makeTempDir('ocbox-release-tag-')
    await writePackageJson(root, '1.2.3')

    const result = spawnSync('bash', ['-e', '-c', script()], {
      cwd: root,
      env: { ...process.env, RELEASE_TAG: 'v1.2.4' },
      encoding: 'utf8',
    })

    const output = commandOutput(result)
    expect(result.status, output).not.toBe(0)
    expect(output).toContain('v1.2.4')
    expect(output).toContain('1.2.3')
  })

  it.skipIf(skipOnWindows)('rejects a tag without the leading v', async () => {
    const root = await makeTempDir('ocbox-release-tag-')
    await writePackageJson(root, '1.2.3')

    const result = spawnSync('bash', ['-e', '-c', script()], {
      cwd: root,
      env: { ...process.env, RELEASE_TAG: '1.2.3' },
      encoding: 'utf8',
    })

    expect(result.status, commandOutput(result)).not.toBe(0)
  })
})

describe('release workflow: release files', () => {
  const script = () => runBlock(workflow, 'Check the release files')

  it('builds the files with the repository pack step', () => {
    expect(workflow).toContain('pnpm run pack:release')
  })

  it.skipIf(skipOnWindows)('accepts the three assets pack-release writes', async () => {
    const root = await makeReleaseFixture()

    const result = spawnSync('bash', ['-e', '-c', script()], {
      cwd: root,
      env: { ...process.env },
      encoding: 'utf8',
    })

    expect(result.status, commandOutput(result)).toBe(0)
  })

  it.skipIf(skipOnWindows)('rejects a fourth file in dist/release', async () => {
    const root = await makeReleaseFixture()
    await writeFile(join(root, 'dist', 'release', 'notes.txt'), 'unexpected\n')

    const result = spawnSync('bash', ['-e', '-c', script()], {
      cwd: root,
      env: { ...process.env },
      encoding: 'utf8',
    })

    expect(result.status, commandOutput(result)).not.toBe(0)
  })

  it.skipIf(skipOnWindows)('rejects a checksum that does not match the tarball', async () => {
    const root = await makeReleaseFixture()
    await writeFile(
      join(root, 'dist', 'release', CHECKSUM_FILE_NAME),
      `${'0'.repeat(64)}  ${releaseTarballName('1.2.3')}\n`,
    )

    const result = spawnSync('bash', ['-e', '-c', script()], {
      cwd: root,
      env: { ...process.env },
      encoding: 'utf8',
    })

    expect(result.status, commandOutput(result)).not.toBe(0)
  })

  it.skipIf(skipOnWindows)(
    'rejects a LATEST file that does not name the package version',
    async () => {
      const root = await makeReleaseFixture()
      await writeFile(join(root, 'dist', 'release', 'LATEST'), '9.9.9\n')

      const result = spawnSync('bash', ['-e', '-c', script()], {
        cwd: root,
        env: { ...process.env },
        encoding: 'utf8',
      })

      expect(result.status, commandOutput(result)).not.toBe(0)
    },
  )
})

describe('release workflow: published assets', () => {
  const publishStep = () => stepText(workflow, 'Publish the GitHub release')
  const checkStep = () => stepText(workflow, 'Check the release files')
  // Resolves to tarball="$release_dir/ocbox-${version}.tgz".
  const tarballExpression = `tarball="$release_dir/${releaseTarballName('${version}')}"`

  it('authenticates with GITHUB_TOKEN and names the resolved tag', () => {
    expect(publishStep()).toMatch(/GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/)
    expect(publishStep()).toMatch(/RELEASE_TAG:\s*\$\{\{\s*steps\.tag\.outputs\.tag\s*\}\}/)
  })

  it('uploads the same three asset names the clients download', () => {
    expect(publishStep()).toContain('release_dir=dist/release')
    expect(publishStep()).toContain(tarballExpression)
    expect(publishStep()).toContain(`sums="$release_dir/${CHECKSUM_FILE_NAME}"`)
    expect(publishStep()).toContain('latest="$release_dir/LATEST"')
  })

  it('passes the assets explicitly instead of uploading a glob', () => {
    expect(publishStep().replace(/\s+/g, ' ')).toContain(
      'gh release create "$RELEASE_TAG" --title "$RELEASE_TAG" --generate-notes --verify-tag "$tarball" "$sums" "$latest"',
    )
    expect(publishStep()).not.toContain('dist/release/*')
    expect(publishStep()).not.toMatch(/\$release_dir\/\*/)
  })

  it('requires exactly three files before publishing', () => {
    expect(checkStep()).toContain('-ne 3')
  })
})

describe('release asset formats', () => {
  it('pins the SHA256SUMS and LATEST formats pack-release writes', async () => {
    const pack = await readFile(join(repoRoot, 'scripts', 'pack-release.mjs'), 'utf8')

    expect(pack).toContain("writeFileSync(join(dir, 'SHA256SUMS'), `${hash}  ${name}\\n`)")
    expect(pack).toContain("writeFileSync(join(dir, 'LATEST'), `${pkg.version}\\n`)")
  })

  it('reads the digest the workflow publishes', async () => {
    const root = await makeTempDir('ocbox-release-sums-')
    const digest = createHash('sha256').update('fixture release bytes\n').digest('hex')
    const asset = releaseTarballName('1.2.3')
    const sums = join(root, CHECKSUM_FILE_NAME)
    await writeFile(sums, `${digest}  ${asset}\n`)

    await expect(readExpectedChecksum(sums, asset)).resolves.toBe(digest)
  })

  it('keeps the install scripts on the same names and second checksum field', async () => {
    const shell = await readFile(join(repoRoot, 'install.sh'), 'utf8')
    const powerShell = await readFile(join(repoRoot, 'install.ps1'), 'utf8')

    expect(shell).toContain(`tarball_name="${RELEASE_TARBALL_PREFIX}\${version}.tgz"`)
    expect(shell).toContain(`"${CHECKSUM_FILE_NAME}"`)
    expect(shell).toContain('file=$2')
    expect(shell).toContain('sub(/^\\*/, "", file)')

    expect(powerShell).toContain(`$tarballName = "${RELEASE_TARBALL_PREFIX}$version.tgz"`)
    expect(powerShell).toContain(`'${CHECKSUM_FILE_NAME}'`)
    expect(powerShell).toContain("-split '\\s+', 2")
  })
})

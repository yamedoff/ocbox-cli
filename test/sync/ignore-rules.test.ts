import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isInteractiveForFlags, syncCliRules } from '../../src/sync/command.js'
import { type IgnoreRule, InvalidIgnoreRuleError } from '../../src/sync/exclusions.js'
import { cliRules, loadIgnoreRuleGroups } from '../../src/sync/ignore-rules.js'
import { scanSourceManifest } from '../../src/sync/manifest.js'

const roots: string[] = []
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ocbox-ignore-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

/** The transferable scan result: exactly the paths a push would send. */
async function scanned(directory: string, cli: readonly IgnoreRule[] = []): Promise<string[]> {
  const groups = await loadIgnoreRuleGroups(directory, cli)
  const manifest = await scanSourceManifest(directory, { ignoreRuleGroups: groups })
  return manifest.entries
    .filter((entry) => entry.exclusionReason === null)
    .map((entry) => entry.path)
}

/**
 * Creates a git repository holding two files that differ only in case. Returns
 * null on a case-insensitive filesystem, where both names address one file.
 */
async function caseSensitiveGitRoot(ignorecase: boolean | undefined): Promise<string | null> {
  const directory = await root()
  await writeFile(join(directory, 'Foo.txt'), 'upper')
  await writeFile(join(directory, 'foo.txt'), 'lower')
  if ((await readdir(directory)).length !== 2) return null
  execFileSync('git', ['init', '--quiet'], { cwd: directory })
  if (ignorecase !== undefined) {
    execFileSync('git', ['config', 'core.ignorecase', String(ignorecase)], { cwd: directory })
  }
  return directory
}

/** Files git would transfer, in the same path form the scan reports. */
function gitFiles(directory: string): string[] {
  return execFileSync('git', ['ls-files', '--others', '--cached', '--exclude-standard'], {
    cwd: directory,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((path) => path.length > 0)
    .sort()
}

describe('sync ignore rules', () => {
  it('loads opencloudboxignore then CLI rules in deterministic precedence order', async () => {
    const directory = await root()
    await writeFile(join(directory, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(directory, '.opencloudboxignore'), 'ignored.txt\n!kept.txt\n')
    await writeFile(join(directory, 'ignored.txt'), 'ignored')
    await writeFile(join(directory, 'kept.txt'), 'kept')
    const groups = await loadIgnoreRuleGroups(directory, [])

    expect(groups.userRuleGroups.map((group) => group[0]?.source)).toEqual([
      'opencloudboxignore',
      undefined,
    ])
    expect(await scanned(directory)).toEqual(['.gitignore', '.opencloudboxignore', 'kept.txt'])
  })

  it('returns empty rule groups when ignore files are absent', async () => {
    const groups = await loadIgnoreRuleGroups(await root(), [])
    expect(groups.infoExclude).toBeNull()
    expect(groups.userRuleGroups).toEqual([[], []])
    expect(groups.gitignoreByFolder.size).toBe(0)
  })

  it('applies a subfolder .gitignore to its own folder and below only', async () => {
    const directory = await root()
    await mkdir(join(directory, 'sub', 'nested'), { recursive: true })
    await mkdir(join(directory, 'other'))
    await writeFile(join(directory, 'sub', '.gitignore'), 'secret.txt\n')
    await writeFile(join(directory, 'sub', 'secret.txt'), 'ignored')
    await writeFile(join(directory, 'sub', 'nested', 'secret.txt'), 'ignored')
    await writeFile(join(directory, 'sub', 'keep.txt'), 'kept')
    await writeFile(join(directory, 'other', 'secret.txt'), 'kept')
    await writeFile(join(directory, 'secret.txt'), 'kept')

    expect(await scanned(directory)).toEqual([
      'other',
      'other/secret.txt',
      'secret.txt',
      'sub',
      'sub/.gitignore',
      'sub/keep.txt',
      'sub/nested',
    ])
  })

  it('keeps files that differ only in case when core.ignorecase is unset, matching git', async () => {
    const directory = await caseSensitiveGitRoot(undefined)
    if (directory === null) return
    await writeFile(join(directory, '.gitignore'), 'foo.txt\n')

    expect(await scanned(directory)).toEqual(gitFiles(directory))
    expect(await scanned(directory)).toContain('Foo.txt')
  })

  it('reads core.ignorecase from the repository config', async () => {
    const insensitive = await caseSensitiveGitRoot(true)
    if (insensitive === null) return
    const sensitive = await caseSensitiveGitRoot(false)
    if (sensitive === null) return

    expect((await loadIgnoreRuleGroups(insensitive, [])).ignorecase).toBe(true)
    expect((await loadIgnoreRuleGroups(sensitive, [])).ignorecase).toBe(false)
  })

  it('accepts an anchored .gitignore rule and anchors it to the project root', async () => {
    const directory = await root()
    await mkdir(join(directory, 'generated'))
    await mkdir(join(directory, 'pkg', 'generated'), { recursive: true })
    await writeFile(join(directory, '.gitignore'), '/generated\n/dist\n')
    await writeFile(join(directory, 'generated', 'out.txt'), 'ignored')
    await writeFile(join(directory, 'pkg', 'generated', 'out.txt'), 'kept')

    expect(await scanned(directory)).toEqual([
      '.gitignore',
      'pkg',
      'pkg/generated',
      'pkg/generated/out.txt',
    ])
  })

  it('reads .git/info/exclude below the .gitignore rules', async () => {
    const directory = await root()
    await mkdir(join(directory, '.git', 'info'), { recursive: true })
    await writeFile(join(directory, '.git', 'info', 'exclude'), '*.log\n')
    await writeFile(join(directory, '.gitignore'), '!keep.log\n')
    await writeFile(join(directory, 'drop.log'), 'ignored')
    await writeFile(join(directory, 'keep.log'), 'kept')

    expect(await scanned(directory)).toEqual(['.gitignore', 'keep.log'])
  })

  it('handles escaped gitignore characters', async () => {
    const directory = await root()
    await writeFile(join(directory, '.gitignore'), '\\#literal\n\\!bang\ntrail\\ \n')
    await writeFile(join(directory, '#literal'), 'ignored')
    await writeFile(join(directory, '!bang'), 'ignored')
    await writeFile(join(directory, 'trail '), 'ignored')
    await writeFile(join(directory, 'trail'), 'kept')
    await writeFile(join(directory, 'other'), 'kept')

    expect(await scanned(directory)).toEqual(['.gitignore', 'other', 'trail'])
  })

  it('matches a directory-only gitignore rule against the directory, not a same-named file', async () => {
    const directory = await root()
    await mkdir(join(directory, 'cache'))
    await mkdir(join(directory, 'sub'))
    await writeFile(join(directory, '.gitignore'), 'cache/\n')
    await writeFile(join(directory, 'cache', 'entry.txt'), 'ignored')
    await writeFile(join(directory, 'sub', 'cache'), 'kept')

    expect(await scanned(directory)).toEqual(['.gitignore', 'sub', 'sub/cache'])
  })

  it('lets .opencloudboxignore re-include a gitignored path', async () => {
    const directory = await root()
    await writeFile(join(directory, '.gitignore'), '*.log\n')
    await writeFile(join(directory, '.opencloudboxignore'), '!/keep.log\n')
    await writeFile(join(directory, 'drop.log'), 'ignored')
    await writeFile(join(directory, 'keep.log'), 'kept')

    expect(await scanned(directory)).toEqual(['.gitignore', '.opencloudboxignore', 'keep.log'])
  })

  it('anchors a leading slash in .opencloudboxignore at the project root', async () => {
    const directory = await root()
    await mkdir(join(directory, 'generated'))
    await mkdir(join(directory, 'pkg', 'generated'), { recursive: true })
    await writeFile(join(directory, '.opencloudboxignore'), '/generated\n')
    await writeFile(join(directory, 'generated', 'out.txt'), 'ignored')
    await writeFile(join(directory, 'pkg', 'generated', 'out.txt'), 'kept')

    expect(await scanned(directory)).toEqual([
      '.opencloudboxignore',
      'pkg',
      'pkg/generated',
      'pkg/generated/out.txt',
    ])
  })

  it('anchors a leading slash in a CLI exclude at the project root', async () => {
    const directory = await root()
    await mkdir(join(directory, 'generated'))
    await mkdir(join(directory, 'pkg', 'generated'), { recursive: true })
    await writeFile(join(directory, 'generated', 'out.txt'), 'ignored')
    await writeFile(join(directory, 'pkg', 'generated', 'out.txt'), 'kept')

    expect(await scanned(directory, cliRules(['/generated']))).toEqual([
      'pkg',
      'pkg/generated',
      'pkg/generated/out.txt',
    ])
  })

  it('maps repeatable CLI excludes and includes', async () => {
    const directory = await root()
    await writeFile(join(directory, 'debug.log'), 'ignored')
    await writeFile(join(directory, 'important.log'), 'kept')

    expect(await scanned(directory, cliRules(['*.log'], ['/important.log']))).toEqual([
      'important.log',
    ])
  })

  it('cannot re-include a built-in secret exclusion', async () => {
    const directory = await root()
    await writeFile(join(directory, '.env'), 'secret')
    await writeFile(join(directory, '.env.local'), 'secret')

    expect(await scanned(directory, cliRules([], ['/**/.env', '/.env.local']))).toEqual([])
  })

  it('rejects traversal patterns instead of tolerating them', () => {
    expect(() => cliRules(['../escape'])).toThrow(InvalidIgnoreRuleError)
  })

  it('maps a rejected CLI pattern to a typed CONFIG_INVALID error', () => {
    expect.assertions(1)
    try {
      syncCliRules({ exclude: ['../escape'] })
      expect.unreachable('expected a typed error')
    } catch (error) {
      expect(error).toMatchObject({ code: 'CONFIG_INVALID' })
    }
  })

  it('treats structured output modes as noninteractive regardless of TTY', () => {
    const descriptors = {
      stdin: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
      stdout: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
    }
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
      expect(isInteractiveForFlags({})).toBe(true)
      expect(isInteractiveForFlags({ json: true })).toBe(false)
      expect(isInteractiveForFlags({ jsonl: true })).toBe(false)
    } finally {
      for (const [name, descriptor] of Object.entries(descriptors)) {
        const stream = name === 'stdin' ? process.stdin : process.stdout
        if (descriptor === undefined) Reflect.deleteProperty(stream, 'isTTY')
        else Object.defineProperty(stream, 'isTTY', descriptor)
      }
    }
  })

  it('does not read excluded directory contents through ignore files', async () => {
    const directory = await root()
    await mkdir(join(directory, 'node_modules'))
    await writeFile(join(directory, '.gitignore'), '!node_modules/\n')
    await writeFile(join(directory, 'node_modules', '.gitignore'), '!*\n')
    const groups = await loadIgnoreRuleGroups(directory, [])
    const manifest = await scanSourceManifest(directory, { ignoreRuleGroups: groups })
    expect(manifest.entries.find((entry) => entry.path === 'node_modules')?.exclusionReason).toBe(
      'dependency-cache',
    )
    expect(
      (groups as { gitignoreByFolder?: Map<string, unknown> }).gitignoreByFolder?.has(
        'node_modules',
      ),
    ).toBe(false)
  })
})

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exclusionForPath, InvalidIgnoreRuleError } from '../../src/sync/exclusions.js'
import { cliRules, loadIgnoreRuleGroups } from '../../src/sync/ignore-rules.js'
import { syncCliRules, isInteractiveForFlags } from '../../src/sync/command.js'
import { normalizeManifestPath } from '../../src/sync/path-policy.js'

const roots: string[] = []
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ocbox-ignore-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

describe('sync ignore rules', () => {
  it('loads gitignore then opencloudboxignore in deterministic precedence order', async () => {
    const directory = await root()
    await writeFile(join(directory, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(directory, '.opencloudboxignore'), 'ignored.txt\n!kept.txt\n')
    const groups = await loadIgnoreRuleGroups(directory, [])
    expect(groups.map((group) => group[0]?.source)).toEqual([
      'gitignore',
      'opencloudboxignore',
      undefined,
    ])
    const path = (value: string) => normalizeManifestPath(value)
    expect(exclusionForPath(path('ignored.txt'), groups)).toBe('user-rule')
    expect(exclusionForPath(path('kept.txt'), groups)).toBeNull()
  })

  it('returns empty groups when ignore files are absent', async () => {
    const groups = await loadIgnoreRuleGroups(await root(), [])
    expect(groups).toEqual([[], [], []])
  })

  it('maps repeatable CLI excludes and includes', async () => {
    const rules = cliRules(['*.log'], ['important.log'])
    const path = (value: string) => normalizeManifestPath(value)
    expect(exclusionForPath(path('debug.log'), [rules])).toBe('user-rule')
    expect(exclusionForPath(path('important.log'), [rules])).toBeNull()
  })

  it('cannot re-include a built-in secret exclusion', async () => {
    const rules = cliRules([], ['**/.env', '**/.env.local'])
    const path = (value: string) => normalizeManifestPath(value)
    expect(exclusionForPath(path('.env'), [rules])).toBe('secret-environment')
    expect(exclusionForPath(path('.env.local'), [rules])).toBe('secret-environment')
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
    const groups = await loadIgnoreRuleGroups(directory, [])
    expect(exclusionForPath(normalizeManifestPath('node_modules'), groups)).toBe('dependency-cache')
  })
})

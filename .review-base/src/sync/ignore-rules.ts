import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type IgnoreRule, parseIgnoreRules } from './exclusions.js'

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function readRuleFile(
  root: string,
  name: string,
  source: IgnoreRule['source'],
): Promise<readonly IgnoreRule[]> {
  let contents: string
  try {
    contents = await readFile(join(root, name), 'utf8')
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  return parseIgnoreRules(contents, source)
}

/**
 * Builds the deterministic precedence chain: built-in exclusions run first and
 * cannot be re-included, then `.gitignore`, then `.opencloudboxignore`, then CLI
 * rules. Later groups override earlier user-authored decisions.
 */
export async function loadIgnoreRuleGroups(
  root: string,
  cliRules: readonly IgnoreRule[],
): Promise<readonly (readonly IgnoreRule[])[]> {
  return [
    await readRuleFile(root, '.gitignore', 'gitignore'),
    await readRuleFile(root, '.opencloudboxignore', 'opencloudboxignore'),
    cliRules,
  ]
}

/** Maps repeatable CLI `--exclude`/`--include` patterns to user ignore rules. */
export function cliRules(
  excludes: readonly string[] = [],
  includes: readonly string[] = [],
): readonly IgnoreRule[] {
  const patterns = [...excludes, ...includes.map((pattern) => `!${pattern}`)]
  return patterns.length === 0 ? [] : parseIgnoreRules(patterns.join('\n'), 'cli')
}

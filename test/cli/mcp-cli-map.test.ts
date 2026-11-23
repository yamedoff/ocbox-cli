import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const mapPath = join(root, 'docs/mcp-cli-map.md')

interface CommandReference {
  readonly command: string
  readonly flags: readonly string[]
}

/** Every backticked `ocbox ...` command in the map, with the long flags it names. */
function commandReferences(markdown: string): CommandReference[] {
  const references: CommandReference[] = []
  for (const match of markdown.matchAll(/`(ocbox [^`]+)`/g)) {
    const line = match[1]?.trim()
    if (line === undefined) continue
    const words = line.split(/\s+/).slice(1)
    const first = words[0]
    if (first === undefined || first.startsWith('-') || first.startsWith('<')) continue
    if (first.startsWith('[')) continue
    const second = words[1]
    const command =
      second !== undefined && /^[a-z][a-z0-9-]*$/.test(second) ? `${first} ${second}` : first
    const flags = [...line.matchAll(/--[a-z][a-z0-9-]*/g)].map((flag) => flag[0] ?? '')
    references.push({ command, flags })
  }
  return references
}

/** Load the command class from the source tree, as oclif would discover it. */
async function loadCommand(command: string): Promise<unknown> {
  const [first, second] = command.split(' ')
  const candidates =
    second === undefined
      ? [join(root, 'src/commands', `${first}.ts`)]
      : [
          join(root, 'src/commands', `${first}`, `${second}.ts`),
          join(root, 'src/commands', `${first}.ts`),
        ]
  for (const candidate of candidates) {
    try {
      const module = (await import(pathToFileURL(candidate).href)) as { default?: unknown }
      if (typeof module.default === 'function') return module.default
    } catch {
      // Try the next spelling before reporting the command as missing.
    }
  }
  return undefined
}

describe('MCP-to-CLI map', () => {
  it('names only CLI commands and long flags that exist', async () => {
    const markdown = await readFile(mapPath, 'utf8')
    const references = commandReferences(markdown)
    expect(references.length).toBeGreaterThan(20)

    const failures: string[] = []
    for (const reference of references) {
      const Command = await loadCommand(reference.command)
      if (Command === undefined) {
        failures.push(`missing command: ocbox ${reference.command}`)
        continue
      }
      const flags = (Command as { flags?: Record<string, unknown> }).flags ?? {}
      for (const flag of reference.flags) {
        if (!Object.hasOwn(flags, flag.slice(2))) {
          failures.push(`missing flag: ocbox ${reference.command} ${flag}`)
        }
      }
    }

    expect(failures).toEqual([])
  })
})

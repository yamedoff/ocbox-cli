import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const mapPath = join(root, 'docs/mcp-cli-map.md')

/**
 * The hosted MCP registry this map promises to cover (`MCP_TOOLS` in
 * apps/api/src/mcp.ts of the opencloudbox repository). The API repository is
 * not a dependency of this CLI, so the names are mirrored here: the map test
 * fails when the table drops one of them or adds a tool the registry does not
 * have.
 */
const HOSTED_MCP_TOOLS = [
  'project_list',
  'project_get',
  'project_create',
  'project_delete',
  'environment_list',
  'environment_get',
  'sizes_list',
  'gpu_check',
  'session_create',
  'session_list',
  'session_get',
  'session_start',
  'session_pause',
  'session_stop',
  'session_destroy',
  'snapshot_create',
  'snapshot_list',
  'snapshot_restore',
  'snapshot_delete',
  'execution_start',
  'execution_get',
  'execution_cancel',
  'operation_get',
  'operation_cancel',
  'source_sync_plan',
  'source_sync_apply',
  'source_push_files',
  'source_read_snapshot',
  'preview_create',
  'usage_list',
  'wallet_get',
] as const

interface CommandReference {
  readonly command: string
  readonly flags: readonly string[]
}

interface MapRow extends CommandReference {
  readonly tool: string
  readonly reasonCodes: string
}

/** Parse one backticked `ocbox ...` command into its command path and long flags. */
function commandReference(line: string): CommandReference | undefined {
  const words = line.split(/\s+/).slice(1)
  const first = words[0]
  if (first === undefined || first.startsWith('-') || first.startsWith('<')) return undefined
  if (first.startsWith('[')) return undefined
  const second = words[1]
  const command =
    second !== undefined && /^[a-z][a-z0-9-]*$/.test(second) ? `${first} ${second}` : first
  const flags = [...line.matchAll(/--[a-z][a-z0-9-]*/g)].map((flag) => flag[0] ?? '')
  return { command, flags }
}

/** Every backticked `ocbox ...` command in the map, with the long flags it names. */
function commandReferences(markdown: string): CommandReference[] {
  const references: CommandReference[] = []
  for (const match of markdown.matchAll(/`(ocbox [^`]+)`/g)) {
    const line = match[1]?.trim()
    if (line === undefined) continue
    const reference = commandReference(line)
    if (reference !== undefined) references.push(reference)
  }
  return references
}

/** The tool, command and reason columns of every table row in the map. */
function mapRows(markdown: string): MapRow[] {
  const rows: MapRow[] = []
  for (const line of markdown.split('\n')) {
    // A table cell escapes a literal pipe as `\|`, so only unescaped pipes
    // separate the columns.
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim())
    if (cells.length !== 6) continue
    const tool = /^`([a-z][a-z0-9_]*)`$/.exec(cells[1] ?? '')
    if (tool === null) continue
    const commandLine = /`(ocbox [^`]+)`/.exec(cells[3] ?? '')?.[1]
    const reference = commandLine === undefined ? undefined : commandReference(commandLine.trim())
    rows.push({
      tool: tool[1] ?? '',
      command: reference?.command ?? '',
      flags: reference?.flags ?? [],
      reasonCodes: cells[4] ?? '',
    })
  }
  return rows
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
  it('lists every hosted MCP tool exactly once', async () => {
    const markdown = await readFile(mapPath, 'utf8')
    const tools = mapRows(markdown).map((row) => row.tool)
    expect(new Set(tools).size).toBe(tools.length)
    expect([...tools].sort()).toEqual([...HOSTED_MCP_TOOLS].sort())
  })

  it('gives every hosted MCP tool a CLI command and reason codes', async () => {
    const markdown = await readFile(mapPath, 'utf8')
    const rows = mapRows(markdown)
    expect(rows.length).toBe(HOSTED_MCP_TOOLS.length)
    expect(rows.filter((row) => row.command === '').map((row) => row.tool)).toEqual([])
    expect(rows.filter((row) => row.reasonCodes === '').map((row) => row.tool)).toEqual([])
  })

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

  it('maps the owner-wide session list without --project-id', async () => {
    const markdown = await readFile(mapPath, 'utf8')
    const row = mapRows(markdown).find((entry) => entry.tool === 'session_list')
    expect(row).toBeDefined()
    expect(row?.command).toBe('session list')
    expect(row?.flags).toEqual(
      expect.arrayContaining(['--project-id', '--cursor', '--limit', '--include-destroyed']),
    )
    expect(row?.flags).not.toContain('--project')

    const sessionListLines = markdown.split('\n').filter((line) => line.includes('session_list'))
    expect(sessionListLines.length).toBeGreaterThan(0)
    expect(sessionListLines.filter((line) => line.includes('MISSING'))).toEqual([])
    expect(markdown.includes('MISSING')).toBe(false)
  })
})

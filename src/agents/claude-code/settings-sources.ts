import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export type ClaudeSettingsSource =
  | 'managed'
  | 'local-project'
  | 'shared-project'
  | 'user'
  | 'explicit'

export interface ClaudeSettingsLayout {
  readonly platform: string
  readonly userSettingsPath: string
  readonly sharedProjectSettingsPath: string
  readonly localProjectSettingsPath: string
  readonly managedSettingsPath: string | null
  readonly precedenceHighToLow: readonly ClaudeSettingsSource[]
}

export interface ClaudeLayoutOptions {
  readonly homeDirectory?: string | undefined
  readonly projectDirectory?: string | undefined
  readonly platformOverride?: string | undefined
  readonly managedPathOverride?: string | null | undefined
  readonly explicitPaths?: readonly string[] | undefined
}

export interface ClaudeSettingsLayout {
  readonly platform: string
  readonly userSettingsPath: string
  readonly sharedProjectSettingsPath: string
  readonly localProjectSettingsPath: string
  readonly managedSettingsPath: string | null
  readonly explicitSettingsPaths: readonly string[]
  readonly precedenceHighToLow: readonly ClaudeSettingsSource[]
}

function defaultManagedPath(currentPlatform: string): string | null {
  if (currentPlatform === 'win32') {
    // biome-ignore lint/complexity/useLiteralKeys: Record index signature access
    const programData = process.env['PROGRAMDATA']
    if (programData !== undefined && programData.length > 0) {
      return join(programData, 'ClaudeCode', 'managed-settings.json')
    }
    return null
  }
  if (currentPlatform === 'darwin') {
    return '/Library/Application Support/ClaudeCode/managed-settings.json'
  }
  return '/etc/claude-code/managed-settings.json'
}

export function resolveClaudeSettingsLayout(
  options: ClaudeLayoutOptions = {},
): ClaudeSettingsLayout {
  const currentPlatform = options.platformOverride ?? platform()
  const home = options.homeDirectory ?? homedir()
  const project = options.projectDirectory ?? process.cwd()
  const managed =
    options.managedPathOverride !== undefined
      ? options.managedPathOverride
      : defaultManagedPath(currentPlatform)
  const explicit = [...(options.explicitPaths ?? [])]
  const precedenceHighToLow: readonly ClaudeSettingsSource[] =
    explicit.length > 0
      ? ['managed', 'explicit', 'local-project', 'shared-project', 'user']
      : ['managed', 'local-project', 'shared-project', 'user']
  return {
    platform: currentPlatform,
    userSettingsPath: join(home, '.claude', 'settings.json'),
    sharedProjectSettingsPath: join(project, '.claude', 'settings.json'),
    localProjectSettingsPath: join(project, '.claude', 'settings.local.json'),
    managedSettingsPath: managed,
    explicitSettingsPaths: explicit,
    precedenceHighToLow,
  }
}

export type AdapterScope = 'user' | 'project' | 'local'

export function targetPathForScope(layout: ClaudeSettingsLayout, scope: AdapterScope): string {
  if (scope === 'user') return layout.userSettingsPath
  if (scope === 'local') return layout.localProjectSettingsPath
  return layout.sharedProjectSettingsPath
}

export const CLAUDE_SETTINGS_PRECEDENCE = [
  'managed',
  'explicit',
  'local-project',
  'shared-project',
  'user',
] as const satisfies readonly ClaudeSettingsSource[]

export function precedenceRank(kind: ClaudeSettingsSource): number {
  return CLAUDE_SETTINGS_PRECEDENCE.indexOf(kind)
}

export interface ClaudeSettingsSourceEntry {
  readonly kind: ClaudeSettingsSource
  readonly precedence: number
  readonly path: string
  readonly writableByAdapter: boolean
}

export function resolveClaudeSettingsSources(
  layout: ClaudeSettingsLayout,
): readonly ClaudeSettingsSourceEntry[] {
  const entries: ClaudeSettingsSourceEntry[] = []
  if (layout.managedSettingsPath !== null) {
    entries.push({
      kind: 'managed',
      precedence: precedenceRank('managed'),
      path: layout.managedSettingsPath,
      writableByAdapter: false,
    })
  }
  for (const explicit of layout.explicitSettingsPaths) {
    entries.push({
      kind: 'explicit',
      precedence: precedenceRank('explicit'),
      path: explicit,
      writableByAdapter: false,
    })
  }
  entries.push(
    {
      kind: 'local-project',
      precedence: precedenceRank('local-project'),
      path: layout.localProjectSettingsPath,
      writableByAdapter: true,
    },
    {
      kind: 'shared-project',
      precedence: precedenceRank('shared-project'),
      path: layout.sharedProjectSettingsPath,
      writableByAdapter: true,
    },
    {
      kind: 'user',
      precedence: precedenceRank('user'),
      path: layout.userSettingsPath,
      writableByAdapter: true,
    },
  )
  return entries.sort((left, right) => left.precedence - right.precedence)
}

export function higherPrecedenceSources(
  sources: readonly ClaudeSettingsSourceEntry[],
  kind: ClaudeSettingsSource,
): readonly ClaudeSettingsSourceEntry[] {
  const rank = precedenceRank(kind)
  return sources.filter((source) => source.precedence < rank)
}

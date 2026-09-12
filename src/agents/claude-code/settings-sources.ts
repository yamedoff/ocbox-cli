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
  return {
    platform: currentPlatform,
    userSettingsPath: join(home, '.claude', 'settings.json'),
    sharedProjectSettingsPath: join(project, '.claude', 'settings.json'),
    localProjectSettingsPath: join(project, '.claude', 'settings.local.json'),
    managedSettingsPath: managed,
    precedenceHighToLow: ['managed', 'local-project', 'shared-project', 'user'],
  }
}

export type AdapterScope = 'user' | 'project' | 'local'

export function targetPathForScope(layout: ClaudeSettingsLayout, scope: AdapterScope): string {
  if (scope === 'user') return layout.userSettingsPath
  if (scope === 'local') return layout.localProjectSettingsPath
  return layout.sharedProjectSettingsPath
}

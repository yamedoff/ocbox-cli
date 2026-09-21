import { parseHooksJsonDocument, parseTomlDocument } from './codec.js'
import { isRecord } from './document.js'
import type { CodexFileSystem } from './fs.js'
import { CODEX_HOOKS_TABLE_KEY, type CodexHookRepresentation } from './hooks.js'
import type { CodexAdapterPaths } from './paths.js'
import { detectCodexSchema } from './schema.js'
import type { CodexSchemaDescriptor } from './version.js'

export interface CodexInstallationInput {
  readonly versionOutput: string
  readonly configToml: string | null
  readonly hooksJson: string | null
}

export interface CodexInstallationReport {
  readonly schema: CodexSchemaDescriptor
  readonly configPresent: boolean
  readonly hooksPresent: boolean
  readonly representationsPresent: readonly CodexHookRepresentation[]
}

export function detectCodexInstallation(input: CodexInstallationInput): CodexInstallationReport {
  const config = parseTomlDocument(input.configToml)
  const hooks = parseHooksJsonDocument(input.hooksJson)
  const schema = detectCodexSchema(input.versionOutput, { config, hooks })
  const representationsPresent: CodexHookRepresentation[] = []
  if (config !== null && isRecord(config[CODEX_HOOKS_TABLE_KEY])) {
    representationsPresent.push('config-toml')
  }
  if (hooks !== null && isRecord(hooks[CODEX_HOOKS_TABLE_KEY])) {
    representationsPresent.push('hooks-json')
  }
  return {
    schema,
    configPresent: input.configToml !== null,
    hooksPresent: input.hooksJson !== null,
    representationsPresent,
  }
}

export async function readCodexInstallation(
  fileSystem: CodexFileSystem,
  paths: CodexAdapterPaths,
  versionOutput: string,
): Promise<CodexInstallationReport> {
  const [configToml, hooksJson] = await Promise.all([
    fileSystem.readFile(paths.userConfigPath),
    fileSystem.readFile(paths.userHooksPath),
  ])
  return detectCodexInstallation({ versionOutput, configToml, hooksJson })
}

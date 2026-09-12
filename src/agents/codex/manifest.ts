import { z } from 'zod'

export const CODEX_MANIFEST_SCHEMA_VERSION = 1 as const

export const CODEX_ADAPTER_VERSION = 'ocbox-codex-adapter-v1' as const

export const CodexManifestSchema = z.strictObject({
  schemaVersion: z.literal(CODEX_MANIFEST_SCHEMA_VERSION),
  adapter: z.literal('codex'),
  adapterVersion: z.literal(CODEX_ADAPTER_VERSION),
  codexVersion: z.string().min(1).max(64),
  layer: z.enum(['user', 'project']),
  codexHome: z.string().min(1).max(1024),
  projectDirectory: z.string().min(1).max(1024).nullable(),
  configFile: z.string().min(1).max(1024),
  hooksFile: z.string().min(1).max(1024),
  hookRepresentation: z.enum(['hooks-json']),
  sessionId: z.string().min(1).max(256),
  ownedTomlText: z.string().max(65_536),
  ownedHooksText: z.string().max(65_536),
  backupConfigPath: z.string().min(1).max(1024).nullable(),
  backupHooksPath: z.string().min(1).max(1024).nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

export type CodexManifest = z.infer<typeof CodexManifestSchema>

export function manifestFile(stateDirectory: string): string {
  return `${stateDirectory}/agents/codex/manifest.json`
}

export function manifestBackupDirectory(stateDirectory: string): string {
  return `${stateDirectory}/agents/codex/backups`
}

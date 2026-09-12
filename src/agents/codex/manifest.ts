import { z } from 'zod'
import { UtcTimestampSchema } from '../../domain/timestamps.js'
import { CodexAdapterError } from './errors.js'
import { CodexHookFragmentSchema, CodexHookRepresentationSchema } from './hooks.js'
import type { CodexLayer } from './paths.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/

export const CODEX_MANIFEST_SCHEMA_VERSION = 1 as const

export const CODEX_ADAPTER_VERSION = 'ocbox-codex-adapter-v1' as const

export const CodexAdapterManifestSchema = z.strictObject({
  schemaVersion: z.literal(CODEX_MANIFEST_SCHEMA_VERSION),
  adapter: z.literal('codex'),
  layer: z.enum(['user', 'project']),
  codexVersion: z.string().min(1).max(64),
  schemaRevision: z.string().min(1).max(64),
  representation: CodexHookRepresentationSchema,
  configPath: z.string().min(1).max(4096),
  hooksPath: z.string().min(1).max(4096),
  sessionId: z.string().min(1).max(256),
  fragments: z.array(CodexHookFragmentSchema).max(256).readonly(),
  configSha256: z.string().regex(SHA256_PATTERN).nullable(),
  hooksSha256: z.string().regex(SHA256_PATTERN).nullable(),
  configCreated: z.boolean(),
  hooksCreated: z.boolean(),
  backupConfigPath: z.string().min(1).max(4096).nullable().optional(),
  backupHooksPath: z.string().min(1).max(4096).nullable().optional(),
  installedAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
})

export type CodexAdapterManifest = z.infer<typeof CodexAdapterManifestSchema>

export type CodexManifest = CodexAdapterManifest

export const CodexManifestSchema = CodexAdapterManifestSchema

export function parseCodexAdapterManifest(source: string): CodexAdapterManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw corruptManifest()
  }
  const result = CodexAdapterManifestSchema.safeParse(parsed)
  if (!result.success) throw corruptManifest()
  return result.data
}

export function serializeCodexAdapterManifest(manifest: CodexAdapterManifest): string {
  return `${JSON.stringify(manifest)}\n`
}

function corruptManifest(): CodexAdapterError {
  return new CodexAdapterError({
    code: 'CODEX_MANIFEST_INVALID',
    message: 'The Codex adapter ownership manifest is corrupt',
    remediation:
      'Remove the adapter manifest under the ocbox state directory and re-run setup; no user configuration is modified by clearing it.',
  })
}

export function manifestFile(stateDirectory: string): string {
  return `${stateDirectory}/agents/codex/manifest.json`
}

export function manifestBackupDirectory(stateDirectory: string): string {
  return `${stateDirectory}/agents/codex/backups`
}

export function manifestPathForLayer(stateDirectory: string, layer: CodexLayer): string {
  return `${stateDirectory}/agents/codex/${layer}/manifest.json`
}

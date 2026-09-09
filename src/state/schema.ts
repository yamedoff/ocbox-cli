import { z } from 'zod'
import {
  ProjectIdSchema,
  ProviderSandboxIdSchema,
  SandboxIdSchema,
  SessionIdSchema,
} from '../domain/ids.js'
import { UtcTimestampSchema } from '../domain/timestamps.js'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/

/** A content-free manifest summary safe to retain between sync operations. */
export const SafeManifestBaselineSchema = z.strictObject({
  algorithm: z.literal('sha256'),
  digest: z.string().regex(SHA256_PATTERN),
  fileCount: z.number().int().nonnegative().safe(),
  totalBytes: z.number().int().nonnegative().safe(),
  recordedAt: UtcTimestampSchema,
})

/** Digests only: no source content, file names, or host paths are persisted. */
export const SyncBaselineSchema = z.strictObject({
  localManifestDigestSha256: z.string().regex(SHA256_PATTERN),
  remoteManifestDigestSha256: z.string().regex(SHA256_PATTERN),
  synchronizedAt: UtcTimestampSchema,
})

export const KnownSessionMappingSchema = z
  .strictObject({
    sessionId: SessionIdSchema,
    sandboxId: SandboxIdSchema.nullable(),
    providerSandboxId: ProviderSandboxIdSchema.nullable(),
    provider: z.string().regex(PROVIDER_NAME_PATTERN),
    lastSafeManifest: SafeManifestBaselineSchema.nullable(),
    lastSyncBaseline: SyncBaselineSchema.nullable(),
    updatedAt: UtcTimestampSchema,
  })
  .superRefine((mapping, context) => {
    if ((mapping.sandboxId === null) !== (mapping.providerSandboxId === null)) {
      context.addIssue({
        code: 'custom',
        path: ['sandboxId'],
        message: 'Internal and provider Sandbox IDs must appear together',
      })
    }
  })

/** Minimal project-local recovery state; configuration and credentials are excluded. */
export const ProjectStateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    projectId: ProjectIdSchema,
    activeSessionId: SessionIdSchema.nullable(),
    sessions: z.record(SessionIdSchema, KnownSessionMappingSchema),
  })
  .superRefine((state, context) => {
    const sandboxIds = new Set<string>()
    for (const [key, mapping] of Object.entries(state.sessions)) {
      if (key !== mapping.sessionId) {
        context.addIssue({
          code: 'custom',
          path: ['sessions', key, 'sessionId'],
          message: 'Session map key must equal its branded Session ID',
        })
      }
      if (mapping.sandboxId !== null) {
        if (sandboxIds.has(mapping.sandboxId)) {
          context.addIssue({
            code: 'custom',
            path: ['sessions', key, 'sandboxId'],
            message: 'A Sandbox can be mapped to only one known Session',
          })
        }
        sandboxIds.add(mapping.sandboxId)
      }
    }
    if (state.activeSessionId !== null && state.sessions[state.activeSessionId] === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['activeSessionId'],
        message: 'Active Session must exist in the known Session map',
      })
    }
  })

export type SafeManifestBaseline = z.infer<typeof SafeManifestBaselineSchema>
export type SyncBaseline = z.infer<typeof SyncBaselineSchema>
export type KnownSessionMapping = z.infer<typeof KnownSessionMappingSchema>
export type ProjectState = z.infer<typeof ProjectStateSchema>

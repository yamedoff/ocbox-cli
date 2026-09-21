import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  createLifecycleService,
  loadProjectConfig,
  resolveStateDirectory,
  type RuntimeFlags,
} from '../cli/runtime.js'
import { RequestIdSchema } from '../domain/ids.js'
import { OcboxError } from '../errors/index.js'
import { InvalidIgnoreRuleError, type IgnoreRule } from './exclusions.js'
import { cliRules } from './ignore-rules.js'
import type { SyncContext } from './service.js'

export interface SyncCommandFlags extends RuntimeFlags {
  readonly session?: string | undefined
  readonly 'local-dir'?: string | undefined
  readonly 'remote-dir'?: string | undefined
  readonly exclude?: readonly string[] | undefined
  readonly include?: readonly string[] | undefined
}

/**
 * Resolves the Session through the T4/T5 lifecycle service (never creating or
 * replacing one) and derives the local root plus the provider/fake workspace
 * root. The remote root defaults to a state-directory location so the v0.1
 * local/fake target works without an explicit flag.
 */
export async function resolveSyncContext(flags: SyncCommandFlags): Promise<SyncContext> {
  const config = await loadProjectConfig(flags)
  const stateDirectory = resolveStateDirectory(flags)
  const view = await (await createLifecycleService(flags)).status(flags.session)
  const sessionId = view.session.id
  const projectId = view.session.projectId
  const localRoot = resolve(process.cwd(), flags['local-dir'] ?? '.')
  const configuredRemote = flags['remote-dir'] ?? process.env['OCBOX_SYNC_REMOTE_DIR']
  const remoteRoot =
    configuredRemote !== undefined && configuredRemote.length > 0
      ? resolve(process.cwd(), configuredRemote)
      : join(stateDirectory, 'sync', projectId, sessionId, 'remote')
  return {
    providerName: config.provider.name,
    projectId,
    sessionId,
    stateDirectory,
    localRoot,
    remoteRoot,
  }
}

export function syncCliRules(flags: SyncCommandFlags): readonly IgnoreRule[] {
  try {
    return cliRules(flags.exclude ?? [], flags.include ?? [])
  } catch (error) {
    if (error instanceof InvalidIgnoreRuleError) {
      throw new OcboxError({
        code: 'CONFIG_INVALID',
        message: 'An ignore pattern is invalid; use a relative, POSIX-style pattern',
        requestId: RequestIdSchema.parse(randomUUID()),
        details: { line: error.line },
      })
    }
    throw error
  }
}

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

/**
 * Structured output modes are noninteractive by contract: they must never
 * prompt on stdout, and destructive mutations require an explicit `--yes`.
 */
export function isInteractiveForFlags(flags: SyncCommandFlags): boolean {
  return isInteractive() && flags.json !== true && flags.jsonl !== true
}

/** Interactive destructive acknowledgement; `--yes` is handled before this. */
export async function confirmSyncDeletion(): Promise<boolean> {
  if (!isInteractive()) return false
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await prompt.question('Apply destructive sync deletions? [y/N] ')
    return answer.trim().toLowerCase() === 'y'
  } finally {
    prompt.close()
  }
}

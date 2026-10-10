import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  createLifecycleService,
  loadProjectConfig,
  resolveStateDirectory,
  type RuntimeFlags,
} from '../cli/runtime.js'
import { LifecycleStore } from '../lifecycle/index.js'
import { createOcboxProvider } from '../providers/ocbox/factory.js'
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
 * Resolves the selected Session through lifecycle status. Hosted uploads use
 * the bound provider's persisted mapping; the offline fake workspace defaults
 * under the state directory.
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
  let hostedUpload: SyncContext['hostedUpload']
  if (config.provider.name === 'ocbox') {
    if (configuredRemote)
      throw new OcboxError({
        code: 'CAPABILITY_UNSUPPORTED',
        message:
          '--remote-dir is available only for the fake provider; hosted source uses the project workspace',
        requestId: RequestIdSchema.parse(randomUUID()),
      })
    if (view.sandbox === null)
      throw new OcboxError({
        code: 'INVALID_STATE',
        message: 'Source upload requires a running hosted sandbox; run ocbox start',
        requestId: RequestIdSchema.parse(randomUUID()),
      })
    const provider = createOcboxProvider({
      stateDirectory,
      apiUrl: flags['api-url'],
      projectId: flags.project ?? process.env['OCBOX_PROJECT_ID'] ?? config.projectId,
    })
    provider.bindLifecycleStore(new LifecycleStore(stateDirectory, projectId))
    const sandboxId = view.sandbox.id
    hostedUpload = (prepared) => provider.uploadSource(sandboxId, prepared)
  }
  return {
    ...(hostedUpload === undefined ? {} : { hostedUpload }),
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

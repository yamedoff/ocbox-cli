import { UtcTimestampSchema } from '../../domain/timestamps.js'
import { capabilityMatrix } from './capabilities.js'
import {
  parseHooksJsonDocument,
  parseTomlDocument,
  serializeHooksJsonDocument,
  serializeTomlDocument,
} from './codec.js'
import { type CodexJsonValue, deepEqual, isRecord, sha256 } from './document.js'
import { CodexAdapterError } from './errors.js'
import type { CodexFileSystem } from './fs.js'
import { buildHookShellCommand, isRecursionGuardActive } from './hook-helper.js'
import {
  CODEX_HOOKS_TABLE_KEY,
  type CodexDesiredFragment,
  type CodexHookEvent,
  type CodexHookFragment,
  type CodexHookRepresentation,
  ensureGroup,
  eventGroups,
  pruneEmptyHooksTable,
  readHooksTable,
  removeGroup,
  toOwnedFragment,
} from './hooks.js'
import {
  CODEX_ADAPTER_VERSION,
  type CodexAdapterManifest,
  type CodexManifest,
  serializeCodexAdapterManifest,
} from './manifest.js'
import { layerTargetFiles, type CodexLayer, type CodexPaths } from './paths.js'
import { detectCodexSchema, validateHooksTable } from './schema.js'
import { checkCodexVersion, LIVE_E2E_BLOCKER } from './version.js'
import type { CodexSchemaDescriptor } from './version.js'

export type CodexPlanStatus =
  | 'installed'
  | 'unchanged'
  | 'removed'
  | 'not-installed'
  | 'repair-required'
  | 'skipped-untrusted-project'

export interface SetupPlanInput {
  readonly versionText: string
  readonly layer: CodexLayer
  readonly trustLevel: string | null
  readonly sessionId: string | null | undefined
  readonly allowUnverifiedSchema?: boolean | undefined
  readonly paths: CodexPaths
  readonly baseTomlText: string | null
  readonly baseHooksText: string | null
  readonly ocboxBin?: string | undefined
  readonly timestamp?: string | undefined
  readonly preferredRepresentation?: CodexHookRepresentation | undefined
  readonly manifest?: CodexManifest | null | undefined
}

export interface PlannedFileChange {
  readonly file: string
  readonly kind: 'toml-merge' | 'hooks-write' | 'config' | 'hooks' | 'manifest'
  readonly before: string | null
  readonly after: string | null
  readonly representation: string
  readonly backupPath: string | null
  readonly existedBefore: boolean
}

export interface SetupPlan {
  readonly ok: boolean
  readonly detectedVersion: string | null
  readonly layer: CodexLayer
  readonly configFile: string
  readonly hooksFile: string
  readonly projectTrusted: boolean | null
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
  readonly changes: readonly PlannedFileChange[]
  readonly alreadyApplied: boolean
  readonly liveBlocker: string
  readonly status: CodexPlanStatus | 'failed'
  readonly drift: CodexDriftReport | null
  readonly repairs: readonly CodexRepairEntry[]
  readonly manifest: CodexManifest | null
  readonly idempotent: boolean
}

export type CodexFileDriftStatus = 'unchanged' | 'modified' | 'missing' | 'created'

export type CodexFragmentDriftStatus = 'intact' | 'missing' | 'modified'

export interface CodexFragmentDrift {
  readonly id: string
  readonly event: CodexHookEvent
  readonly matcher: string | null
  readonly status: CodexFragmentDriftStatus
  readonly recorded: CodexJsonValue
  readonly current: CodexJsonValue | null
}

export interface CodexDriftReport {
  readonly representation: CodexHookRepresentation
  readonly fragments: readonly CodexFragmentDrift[]
  readonly config: CodexFileDriftStatus
  readonly hooks: CodexFileDriftStatus
  readonly drifted: boolean
}

export interface DriftReport {
  readonly status: 'clean' | 'drifted' | 'corrupted' | 'missing' | 'no-manifest'
  readonly details: readonly string[]
}

export type CodexRepairReason = 'user-modified-owned-fragment' | 'duplicated-representation'

export interface CodexRepairEntry {
  readonly reason: CodexRepairReason
  readonly id: string
  readonly event: CodexHookEvent
  readonly matcher: string | null
  readonly recorded: CodexJsonValue
  readonly current: CodexJsonValue
  readonly desired: CodexJsonValue | null
  readonly preserved: true
}

export interface RemovePlanInput {
  readonly manifest: CodexManifest | null
  readonly currentTomlText: string | null
  readonly currentHooksText: string | null
  readonly originalTomlText: string | null
  readonly originalHooksText: string | null
}

export interface RemoveFileAction {
  readonly file: string
  readonly action: 'restore' | 'strip-owned' | 'delete' | 'preserve-and-plan' | 'noop'
  readonly after: string | null
  readonly preservedCopy: string | null
  readonly detail: string
  readonly backupPath: string | null
}

export interface RemovePlan {
  readonly ok: boolean
  readonly actions: readonly RemoveFileAction[]
  readonly repairSteps: readonly string[]
  readonly warnings: readonly string[]
  readonly status: CodexPlanStatus | 'failed'
  readonly repairs: readonly CodexRepairEntry[]
  readonly drift: CodexDriftReport | null
  readonly idempotent: boolean
}

export interface DoctorCheck {
  readonly id: string
  readonly status: 'ok' | 'warning' | 'fail'
  readonly summary: string
  readonly remediation: string | null
}

export interface DoctorInput {
  readonly versionText: string
  readonly tomlText: string | null
  readonly hooksText: string | null
  readonly manifest: CodexManifest | null
  readonly trustLevel: string | null
  readonly sessionId: string | null | undefined
  readonly sessionRecorded: boolean
  readonly environment: Readonly<Record<string, string | undefined>>
}

export interface ThreeWayRepair {
  readonly recorded: CodexJsonValue
  readonly current: CodexJsonValue | null
  readonly desired: CodexJsonValue | null
  readonly action: 'already-desired' | 'take-desired' | 'recreate' | 'preserve-both'
}

export function computeThreeWayRepair(
  recorded: CodexJsonValue,
  current: CodexJsonValue | null,
  desired: CodexJsonValue | null,
): ThreeWayRepair {
  if (current === null) return { recorded, current, desired, action: 'recreate' }
  if (desired !== null && deepEqual(current, desired)) {
    return { recorded, current, desired, action: 'already-desired' }
  }
  if (deepEqual(current, recorded)) {
    return { recorded, current, desired, action: 'take-desired' }
  }
  return { recorded, current, desired, action: 'preserve-both' }
}

export function contentSha256(content: string | null): string | null {
  return content === null ? null : sha256(content)
}

function normalizeNewlines(text: string): string {
  return text.replaceAll('\r\n', '\n')
}

function timestampNow(provided?: string): string {
  if (provided !== undefined) {
    const parsed = UtcTimestampSchema.safeParse(provided)
    if (parsed.success) return parsed.data
  }
  return new Date().toISOString()
}

function desiredSessionFragment(sessionId: string, ocboxBin?: string): CodexDesiredFragment {
  const command = buildHookShellCommand({
    sessionId,
    ...(ocboxBin === undefined ? {} : { ocboxBin }),
  })
  return {
    event: 'PreToolUse',
    matcher: 'shell',
    group: { matcher: 'shell', hooks: [{ type: 'command', command }] },
  }
}

function representationFor(
  manifest: CodexAdapterManifest | null,
  config: Record<string, unknown> | null,
  hooks: Record<string, unknown> | null,
  preferred: CodexHookRepresentation | undefined,
): CodexHookRepresentation {
  if (manifest !== null) return manifest.representation
  if (config !== null && isRecord(config[CODEX_HOOKS_TABLE_KEY])) return 'config-toml'
  if (hooks !== null && isRecord(hooks[CODEX_HOOKS_TABLE_KEY])) return 'hooks-json'
  return preferred ?? 'hooks-json'
}

function emptyDrift(representation: CodexHookRepresentation): CodexDriftReport {
  return { representation, fragments: [], config: 'unchanged', hooks: 'unchanged', drifted: false }
}

function fileDriftStatus(
  currentSource: string | null,
  recorded: string | null,
): CodexFileDriftStatus {
  if (currentSource === null) return recorded === null ? 'unchanged' : 'missing'
  if (recorded === null) return 'created'
  return contentSha256(currentSource) === recorded ? 'unchanged' : 'modified'
}

function groupMatcher(group: unknown): string | null {
  if (!isRecord(group)) return null
  const matcher = group['matcher']
  return typeof matcher === 'string' ? matcher : null
}

function findDrift(
  table: Record<string, unknown> | null,
  fragment: CodexHookFragment,
): CodexFragmentDrift {
  const groups = table === null ? [] : eventGroups(table, fragment.event)
  const identical = groups.find((group) => deepEqual(group, fragment.group))
  if (identical !== undefined) {
    return {
      id: fragment.id,
      event: fragment.event,
      matcher: fragment.matcher,
      status: 'intact',
      recorded: fragment.group,
      current: identical as CodexJsonValue,
    }
  }
  const sameMatcher = groups.find((group) => groupMatcher(group) === fragment.matcher)
  if (sameMatcher !== undefined) {
    return {
      id: fragment.id,
      event: fragment.event,
      matcher: fragment.matcher,
      status: 'modified',
      recorded: fragment.group,
      current: sameMatcher as CodexJsonValue,
    }
  }
  return {
    id: fragment.id,
    event: fragment.event,
    matcher: fragment.matcher,
    status: 'missing',
    recorded: fragment.group,
    current: null,
  }
}

function tableFor(
  representation: CodexHookRepresentation,
  manifest: CodexAdapterManifest,
  config: Record<string, unknown> | null,
  hooks: Record<string, unknown> | null,
): Record<string, unknown> | null {
  void manifest
  return representation === 'config-toml' ? readHooksTable(config) : readHooksTable(hooks)
}

function buildFragmentDrift(
  manifest: CodexAdapterManifest,
  config: Record<string, unknown> | null,
  hooks: Record<string, unknown> | null,
  currentToml: string | null,
  currentHooks: string | null,
): CodexDriftReport {
  const table = tableFor(manifest.representation, manifest, config, hooks)
  const fragments = manifest.fragments.map((fragment) => findDrift(table, fragment))
  const configStatus = fileDriftStatus(currentToml, manifest.configSha256)
  const hooksStatus = fileDriftStatus(currentHooks, manifest.hooksSha256)
  return {
    representation: manifest.representation,
    fragments,
    config: configStatus,
    hooks: hooksStatus,
    drifted:
      fragments.some((fragment) => fragment.status !== 'intact') ||
      configStatus !== 'unchanged' ||
      hooksStatus !== 'unchanged',
  }
}

function sameFragmentSet(
  left: readonly CodexHookFragment[],
  right: readonly CodexHookFragment[],
): boolean {
  if (left.length !== right.length) return false
  const ids = new Set(left.map((fragment) => fragment.id))
  return right.every((fragment) => ids.has(fragment.id))
}

function cloneDocument(document: Record<string, unknown> | null): Record<string, unknown> | null {
  if (document === null) return null
  return JSON.parse(JSON.stringify(document)) as Record<string, unknown>
}

function ensureHooksTable(document: Record<string, unknown>): Record<string, unknown> {
  const existing = document[CODEX_HOOKS_TABLE_KEY]
  if (isRecord(existing)) return existing
  const table: Record<string, unknown> = {}
  document[CODEX_HOOKS_TABLE_KEY] = table
  return table
}

function failedSetup(
  input: SetupPlanInput,
  targets: { readonly configFile: string; readonly hooksFile: string },
  detectedVersion: string | null,
  projectTrusted: boolean | null,
  errors: readonly string[],
  warnings: readonly string[],
): SetupPlan {
  return {
    ok: false,
    detectedVersion,
    layer: input.layer,
    configFile: targets.configFile,
    hooksFile: targets.hooksFile,
    projectTrusted,
    errors,
    warnings,
    changes: [],
    alreadyApplied: false,
    liveBlocker: LIVE_E2E_BLOCKER,
    status: 'failed',
    drift: null,
    repairs: [],
    manifest: input.manifest ?? null,
    idempotent: false,
  }
}

export function planCodexSetup(input: SetupPlanInput, manifest?: CodexManifest | null): SetupPlan {
  const errors: string[] = []
  const warnings: string[] = [
    'The Codex adapter is a routing aid, not host isolation and not a security boundary.',
  ]
  const targets = layerTargetFiles(input.paths, input.layer)
  const effectiveManifest = (manifest ?? input.manifest ?? null) as CodexAdapterManifest | null
  const version = checkCodexVersion(input.versionText)
  if (version.status !== 'supported') {
    errors.push(version.remediation ?? 'Unsupported Codex version.')
  }
  const projectTrusted = input.layer === 'project' ? input.trustLevel === 'trusted' : null
  if (input.layer === 'project' && projectTrusted !== true) {
    errors.push(
      'Project layer selected but the repository is not trusted; project hooks are skipped and the repository is not auto-trusted. Trust it in Codex first or use --layer user.',
    )
  }
  if (input.sessionId === null || input.sessionId === undefined || input.sessionId.length === 0) {
    errors.push(
      'No usable Session for remote routing; failing closed. Select a Session with `ocbox use <session>` or pass --session explicitly.',
    )
  }
  let config: Record<string, unknown> | null = null
  let hooks: Record<string, unknown> | null = null
  try {
    config = parseTomlDocument(input.baseTomlText)
  } catch (error) {
    errors.push(
      error instanceof CodexAdapterError
        ? `${error.message} ${error.remediation}`
        : 'Codex config is corrupted (unparseable TOML); refusing to merge. Restore from a backup or remove the damage, then retry.',
    )
  }
  try {
    hooks = parseHooksJsonDocument(input.baseHooksText)
  } catch (error) {
    errors.push(
      error instanceof CodexAdapterError
        ? `${error.message} ${error.remediation}`
        : 'Codex hooks file is corrupted (unparseable JSON); refusing to merge. Restore from a backup or remove the damage, then retry.',
    )
  }
  let schema: CodexSchemaDescriptor | null = null
  if (errors.length === 0) {
    try {
      schema = detectCodexSchema(input.versionText, { config, hooks })
    } catch (error) {
      errors.push(
        error instanceof CodexAdapterError
          ? `${error.message} ${error.remediation}`
          : 'Codex schema is not recognized; refusing to merge.',
      )
    }
  }
  if (input.allowUnverifiedSchema === false) {
    warnings.push(
      'The --allow-unverified-schema flag is deprecated: the pinned schema gate now proves the hooks shape, so setup proceeds without it.',
    )
  }
  if (errors.length > 0 || schema === null) {
    return failedSetup(input, targets, version.detected, projectTrusted, errors, warnings)
  }
  const sessionId = input.sessionId as string
  const representation = representationFor(
    effectiveManifest,
    config,
    hooks,
    input.preferredRepresentation,
  )
  let workingConfig = cloneDocument(config)
  let workingHooks = cloneDocument(hooks)
  if (representation === 'config-toml') workingConfig ??= {}
  else workingHooks ??= {}
  const targetDocument = representation === 'config-toml' ? workingConfig : workingHooks
  if (targetDocument === null) {
    return failedSetup(
      input,
      targets,
      version.detected,
      projectTrusted,
      ['Planner failed to allocate the target document.'],
      warnings,
    )
  }
  const desiredOwned = [toOwnedFragment(desiredSessionFragment(sessionId, input.ocboxBin))]

  let targetDirty = false
  const table = ensureHooksTable(targetDocument)
  const sessionRotated =
    effectiveManifest !== null &&
    effectiveManifest.fragments.length > 0 &&
    effectiveManifest.sessionId !== sessionId
  if (sessionRotated && effectiveManifest !== null) {
    for (const fragment of effectiveManifest.fragments) {
      const superseded = desiredOwned.some(
        (desired) =>
          desired.event === fragment.event &&
          desired.matcher === fragment.matcher &&
          desired.id !== fragment.id,
      )
      if (superseded && removeGroup(table, fragment)) targetDirty = true
    }
  }
  for (const fragment of desiredOwned) {
    if (ensureGroup(table, fragment)) targetDirty = true
  }

  const duplicateEntries: CodexRepairEntry[] = []
  const nonTarget = representation === 'config-toml' ? workingHooks : workingConfig
  if (nonTarget !== null) {
    const nonTargetTable = readHooksTable(nonTarget)
    if (nonTargetTable !== null) {
      for (const fragment of desiredOwned) {
        if (removeGroup(nonTargetTable, fragment)) {
          duplicateEntries.push({
            reason: 'duplicated-representation',
            id: fragment.id,
            event: fragment.event,
            matcher: fragment.matcher,
            recorded: fragment.group,
            current: fragment.group,
            desired: null,
            preserved: true,
          })
        }
      }
      if (duplicateEntries.length > 0) pruneEmptyHooksTable(nonTarget)
    }
  }
  const mergedConfig = workingConfig
  const mergedHooks = workingHooks
  let nextConfig = input.baseTomlText
  let nextHooks = input.baseHooksText
  if (representation === 'config-toml') {
    if (targetDirty) nextConfig = serializeTomlDocument(targetDocument)
    if (duplicateEntries.length > 0 && workingHooks !== null) {
      nextHooks = serializeHooksJsonDocument(workingHooks)
    }
  } else {
    if (targetDirty) nextHooks = serializeHooksJsonDocument(targetDocument)
    if (duplicateEntries.length > 0 && workingConfig !== null) {
      nextConfig = serializeTomlDocument(workingConfig)
    }
  }

  const driftConfig = cloneDocument(config)
  const driftHooks = cloneDocument(hooks)
  const drift: CodexDriftReport =
    effectiveManifest === null
      ? emptyDrift(representation)
      : buildFragmentDrift(
          effectiveManifest,
          driftConfig,
          driftHooks,
          input.baseTomlText,
          input.baseHooksText,
        )

  const retained = (effectiveManifest?.fragments ?? []).filter((fragment) => {
    if (
      sessionRotated &&
      desiredOwned.some(
        (desired) =>
          desired.event === fragment.event &&
          desired.matcher === fragment.matcher &&
          desired.id !== fragment.id,
      )
    ) {
      return false
    }
    const afterTable = readHooksTable(representation === 'config-toml' ? mergedConfig : mergedHooks)
    if (afterTable === null) return false
    return eventGroups(afterTable, fragment.event).some((group) => deepEqual(group, fragment.group))
  })
  const union = new Map<string, CodexHookFragment>()
  for (const fragment of [...retained, ...desiredOwned]) union.set(fragment.id, fragment)
  const fragments = [...union.values()].sort((left, right) => left.id.localeCompare(right.id))

  const unchanged =
    effectiveManifest !== null &&
    !targetDirty &&
    duplicateEntries.length === 0 &&
    effectiveManifest.representation === representation &&
    effectiveManifest.schemaRevision === schema.revision &&
    sameFragmentSet(effectiveManifest.fragments, fragments)
  if (duplicateEntries.length > 0) {
    warnings.push(
      'A duplicate owned hook existed in both representations; the non-target copy was pruned while unrelated hooks were preserved.',
    )
  }
  if (unchanged) {
    return {
      ok: true,
      detectedVersion: version.detected,
      layer: input.layer,
      configFile: targets.configFile,
      hooksFile: targets.hooksFile,
      projectTrusted,
      errors,
      warnings,
      changes: [],
      alreadyApplied: true,
      liveBlocker: LIVE_E2E_BLOCKER,
      status: 'unchanged',
      drift,
      repairs: [],
      manifest: effectiveManifest,
      idempotent: true,
    }
  }

  const timestamp = timestampNow(input.timestamp)
  const nextBackupConfigPath =
    effectiveManifest?.backupConfigPath ??
    (input.baseTomlText !== null ? input.paths.backupPath(targets.configFile, timestamp) : null)
  const nextBackupHooksPath =
    effectiveManifest?.backupHooksPath ??
    (input.baseHooksText !== null ? input.paths.backupPath(targets.hooksFile, timestamp) : null)
  const nextManifest: CodexAdapterManifest = {
    schemaVersion: 1,
    adapter: 'codex',
    layer: input.layer,
    codexVersion: schema.codexVersion,
    schemaRevision: schema.revision,
    representation,
    configPath: targets.configFile,
    hooksPath: targets.hooksFile,
    sessionId,
    fragments,
    configSha256: contentSha256(nextConfig),
    hooksSha256: contentSha256(nextHooks),
    configCreated: effectiveManifest?.configCreated ?? input.baseTomlText === null,
    hooksCreated: effectiveManifest?.hooksCreated ?? input.baseHooksText === null,
    backupConfigPath: nextBackupConfigPath ?? null,
    backupHooksPath: nextBackupHooksPath ?? null,
    installedAt: effectiveManifest?.installedAt ?? UtcTimestampSchema.parse(timestamp),
    updatedAt: UtcTimestampSchema.parse(timestamp),
  }
  const changes: PlannedFileChange[] = []
  if (nextConfig !== input.baseTomlText) {
    changes.push({
      file: targets.configFile,
      kind: 'toml-merge',
      before: input.baseTomlText,
      after: nextConfig,
      representation: 'config-toml',
      backupPath:
        input.baseTomlText !== null ? input.paths.backupPath(targets.configFile, timestamp) : null,
      existedBefore: input.baseTomlText !== null,
    })
  }
  if (nextHooks !== input.baseHooksText) {
    changes.push({
      file: targets.hooksFile,
      kind: 'hooks-write',
      before: input.baseHooksText,
      after: nextHooks,
      representation: 'hooks-json',
      backupPath:
        input.baseHooksText !== null ? input.paths.backupPath(targets.hooksFile, timestamp) : null,
      existedBefore: input.baseHooksText !== null,
    })
  }
  const manifestPath = (() => {
    try {
      return input.paths.manifestPath(input.layer)
    } catch {
      return null
    }
  })()
  if (manifestPath !== null) {
    changes.push({
      file: manifestPath,
      kind: 'manifest',
      before: effectiveManifest === null ? null : serializeCodexAdapterManifest(effectiveManifest),
      after: serializeCodexAdapterManifest(nextManifest),
      representation: 'manifest-json',
      backupPath: null,
      existedBefore: effectiveManifest !== null,
    })
  }
  return {
    ok: true,
    detectedVersion: version.detected,
    layer: input.layer,
    configFile: targets.configFile,
    hooksFile: targets.hooksFile,
    projectTrusted,
    errors,
    warnings,
    changes,
    alreadyApplied: false,
    liveBlocker: LIVE_E2E_BLOCKER,
    status: changes.length === 0 ? 'unchanged' : 'installed',
    drift,
    repairs: duplicateEntries,
    manifest: nextManifest,
    idempotent: false,
  }
}

export function detectCodexDrift(
  manifest: CodexManifest | null,
  currentTomlText: string | null,
  currentHooksText: string | null,
): DriftReport {
  if (manifest === null) return { status: 'no-manifest', details: ['No adapter manifest exists.'] }
  const details: string[] = []
  let config: Record<string, unknown> | null = null
  let hooks: Record<string, unknown> | null = null
  try {
    config = parseTomlDocument(currentTomlText)
  } catch {
    return { status: 'corrupted', details: ['Config file is unparseable TOML.'] }
  }
  try {
    hooks = parseHooksJsonDocument(currentHooksText)
  } catch {
    return { status: 'corrupted', details: ['Hooks file is unparseable JSON.'] }
  }
  try {
    validateHooksTable(config === null ? undefined : config[CODEX_HOOKS_TABLE_KEY], 'config.toml')
    validateHooksTable(hooks === null ? undefined : hooks[CODEX_HOOKS_TABLE_KEY], 'hooks.json')
  } catch (error) {
    details.push(
      error instanceof CodexAdapterError ? error.message : 'Hook schema is not recognized.',
    )
  }
  const typed = manifest as CodexAdapterManifest
  const table = tableFor(typed.representation, typed, config, hooks)
  for (const fragment of typed.fragments) {
    const drift = findDrift(table, fragment)
    if (drift.status === 'missing') details.push(`Owned hook ${fragment.id} is missing.`)
    else if (drift.status === 'modified') details.push(`Owned hook ${fragment.id} was modified.`)
  }
  if (contentSha256(currentTomlText) !== typed.configSha256) {
    if (currentTomlText === null) details.push('Config file is missing.')
    else details.push('Config file differs from the manifest-owned text.')
  }
  if (contentSha256(currentHooksText) !== typed.hooksSha256) {
    if (currentHooksText === null) details.push('Hooks file is missing.')
    else details.push('Hooks file differs from the manifest-owned text.')
  }
  if (details.length === 0) return { status: 'clean', details: ['Owned fragments match.'] }
  return { status: 'drifted', details }
}

export function planCodexRemove(input: RemovePlanInput): RemovePlan {
  const warnings: string[] = []
  const repairSteps: string[] = []
  const actions: RemoveFileAction[] = []
  if (input.manifest === null) {
    return {
      ok: true,
      actions,
      repairSteps,
      warnings: ['No adapter manifest; nothing owned to remove.'],
      status: 'not-installed',
      repairs: [],
      drift: null,
      idempotent: true,
    }
  }
  const manifest = input.manifest as CodexAdapterManifest
  const representation = manifest.representation
  let config: Record<string, unknown> | null = null
  let hooks: Record<string, unknown> | null = null
  let corrupted: string | null = null
  try {
    config = parseTomlDocument(input.currentTomlText)
  } catch {
    corrupted = 'config'
  }
  try {
    hooks = parseHooksJsonDocument(input.currentHooksText)
  } catch {
    corrupted = corrupted === null ? 'hooks' : 'config+hooks'
  }
  if (corrupted !== null) {
    const failed: RemoveFileAction[] = []
    if (input.currentTomlText !== null) {
      failed.push({
        file: manifest.configPath,
        action: 'noop',
        after: input.currentTomlText,
        preservedCopy: null,
        detail: 'Config file is corrupted; refusing to rewrite until it is repaired.',
        backupPath: null,
      })
      repairSteps.push(
        'Config file is corrupted: restore it from a timestamped .ocbox-backup copy, then re-run doctor.',
      )
    }
    if (input.currentHooksText !== null) {
      failed.push({
        file: manifest.hooksPath,
        action: 'noop',
        after: input.currentHooksText,
        preservedCopy: null,
        detail: 'Hooks file is corrupted; refusing to rewrite until it is repaired.',
        backupPath: null,
      })
      repairSteps.push(
        'Hooks file is corrupted: restore it from a timestamped .ocbox-backup copy, then re-run doctor.',
      )
    }
    return {
      ok: true,
      actions: failed,
      repairSteps,
      warnings: ['Owned files are corrupted; removal is refused rather than guessing.'],
      status: 'repair-required',
      repairs: [],
      drift: null,
      idempotent: false,
    }
  }
  const drift = buildFragmentDrift(
    manifest,
    config,
    hooks,
    input.currentTomlText,
    input.currentHooksText,
  )
  const repairs: CodexRepairEntry[] = []
  for (const fragmentDrift of drift.fragments) {
    if (fragmentDrift.status !== 'modified') continue
    repairs.push({
      reason: 'user-modified-owned-fragment',
      id: fragmentDrift.id,
      event: fragmentDrift.event,
      matcher: fragmentDrift.matcher,
      recorded: fragmentDrift.recorded,
      current: fragmentDrift.current as CodexJsonValue,
      desired: null,
      preserved: true,
    })
  }
  if (repairs.length > 0) {
    return {
      ok: true,
      actions: [],
      repairSteps: [
        'User edits overlap adapter-owned fragments. Both copies are preserved; resolve the three-way repair before removal: keep the user edit, restore the recorded fragment, or copy the current file aside and re-run remove.',
      ],
      warnings: ['User edits detected in owned fragments; nothing was written.'],
      status: 'repair-required',
      repairs,
      drift,
      idempotent: false,
    }
  }

  const currentToml =
    input.currentTomlText === null ? null : normalizeNewlines(input.currentTomlText)
  const currentHooks =
    input.currentHooksText === null ? null : normalizeNewlines(input.currentHooksText)
  const originalToml =
    input.originalTomlText === null ? null : normalizeNewlines(input.originalTomlText)
  const originalHooks =
    input.originalHooksText === null ? null : normalizeNewlines(input.originalHooksText)
  const intactToml =
    input.currentTomlText !== null && contentSha256(input.currentTomlText) === manifest.configSha256
  const intactHooks =
    input.currentHooksText !== null &&
    contentSha256(input.currentHooksText) === manifest.hooksSha256

  if (input.currentTomlText === null) {
    actions.push({
      file: manifest.configPath,
      action: 'noop',
      after: null,
      preservedCopy: null,
      detail: 'Config file already absent.',
      backupPath: null,
    })
  } else if (intactToml) {
    if (originalToml === null) {
      if (representation !== 'config-toml') {
        actions.push({
          file: manifest.configPath,
          action: 'noop',
          after: input.currentTomlText,
          preservedCopy: null,
          detail: 'Config file holds no owned representation; leaving it untouched.',
          backupPath: null,
        })
      } else {
        const stripped = serializeTomlDocument(stripManifestFragments(config, manifest))
        const empty = stripped.length === 0
        actions.push({
          file: manifest.configPath,
          action: empty ? 'delete' : 'strip-owned',
          after: empty ? null : stripped,
          preservedCopy: null,
          detail: 'Config matches the manifest; removing only owned fragments.',
          backupPath: null,
        })
      }
    } else {
      actions.push({
        file: manifest.configPath,
        action: 'restore',
        after: input.originalTomlText,
        preservedCopy: null,
        detail: 'Config matches the manifest; restoring the timestamped backup.',
        backupPath: null,
      })
    }
  } else if (originalToml !== null && currentToml === originalToml) {
    actions.push({
      file: manifest.configPath,
      action: 'noop',
      after: input.currentTomlText,
      preservedCopy: null,
      detail: 'Config already equals the pre-setup backup.',
      backupPath: null,
    })
  } else {
    const preserved = `${manifest.configPath}.ocbox-preserved`
    const fallback =
      input.originalTomlText ?? serializeTomlDocument(stripManifestFragments(config, manifest))
    actions.push({
      file: manifest.configPath,
      action: 'preserve-and-plan',
      after: fallback.length === 0 ? null : fallback,
      preservedCopy: preserved,
      detail: 'Config was edited after setup; preserving the current copy before restoring.',
      backupPath: null,
    })
    repairSteps.push(
      `Config file drifted: copy the current file to ${preserved}, restore the backup content, then re-run doctor.`,
    )
    warnings.push('User edits detected in the config file; both copies are preserved.')
  }

  if (input.currentHooksText === null) {
    actions.push({
      file: manifest.hooksPath,
      action: 'noop',
      after: null,
      preservedCopy: null,
      detail: 'Hooks file already absent.',
      backupPath: null,
    })
  } else if (intactHooks) {
    if (originalHooks === null) {
      if (representation !== 'hooks-json') {
        actions.push({
          file: manifest.hooksPath,
          action: 'noop',
          after: input.currentHooksText,
          preservedCopy: null,
          detail: 'Hooks file holds no owned representation; leaving it untouched.',
          backupPath: null,
        })
      } else {
        const stripped = serializeHooksJsonDocument(stripManifestFragments(hooks, manifest))
        const empty = Object.keys(parseHooksJsonLenient(stripped)).length === 0
        actions.push({
          file: manifest.hooksPath,
          action: empty ? 'delete' : 'strip-owned',
          after: empty ? null : stripped,
          preservedCopy: null,
          detail: 'Hooks file matches the manifest; removing only the owned entry.',
          backupPath: null,
        })
      }
    } else {
      actions.push({
        file: manifest.hooksPath,
        action: 'restore',
        after: input.originalHooksText,
        preservedCopy: null,
        detail: 'Hooks file matches the manifest; restoring the timestamped backup.',
        backupPath: null,
      })
    }
  } else if (originalHooks !== null && currentHooks === originalHooks) {
    actions.push({
      file: manifest.hooksPath,
      action: 'noop',
      after: input.currentHooksText,
      preservedCopy: null,
      detail: 'Hooks file already equals the pre-setup backup.',
      backupPath: null,
    })
  } else {
    const preserved = `${manifest.hooksPath}.ocbox-preserved`
    const fallback =
      input.originalHooksText ?? serializeHooksJsonDocument(stripManifestFragments(hooks, manifest))
    actions.push({
      file: manifest.hooksPath,
      action: 'preserve-and-plan',
      after: fallback,
      preservedCopy: preserved,
      detail: 'Hooks file was edited after setup; preserving the current copy before restoring.',
      backupPath: null,
    })
    repairSteps.push(
      `Hooks file drifted: copy the current file to ${preserved}, restore the backup content, then re-run doctor.`,
    )
    warnings.push('User edits detected in the hooks file; both copies are preserved.')
  }
  return {
    ok: true,
    actions,
    repairSteps,
    warnings,
    status: 'removed',
    repairs: [],
    drift,
    idempotent: false,
  }
}

function stripManifestFragments(
  document: Record<string, unknown> | null,
  manifest: CodexAdapterManifest,
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(document ?? {})) as Record<string, unknown>
  const table = readHooksTable(cloned)
  if (table !== null) {
    for (const fragment of manifest.fragments) removeGroup(table, fragment)
    pruneEmptyHooksTable(cloned)
  }
  return cloned
}

function parseHooksJsonLenient(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    void 0
  }
  return {}
}

export async function applyCodexChangePlan(
  plan: { readonly files: readonly PlannedFileChange[] },
  fileSystem: CodexFileSystem,
): Promise<void> {
  if (plan.files.length === 0) return
  const applied: PlannedFileChange[] = []
  try {
    for (const change of plan.files) {
      if (change.existedBefore && change.backupPath !== null && change.before !== null) {
        await fileSystem.writeFileAtomic(change.backupPath, change.before)
      }
      if (change.after === null) {
        await fileSystem.deleteFile(change.file)
      } else {
        await fileSystem.writeFileAtomic(change.file, change.after)
      }
      applied.push(change)
    }
  } catch {
    const failures: unknown[] = []
    for (const change of [...applied].reverse()) {
      try {
        if (change.existedBefore && change.before !== null) {
          await fileSystem.writeFileAtomic(change.file, change.before)
        } else {
          await fileSystem.deleteFile(change.file)
        }
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new CodexAdapterError({
        code: 'CODEX_ROLLBACK_FAILED',
        message: 'The Codex adapter write failed and rollback could not fully restore prior files',
        remediation:
          'Restore the affected files from the timestamped .ocbox-backup copies before retrying.',
      })
    }
    throw new CodexAdapterError({
      code: 'CODEX_APPLY_FAILED',
      message: 'The Codex adapter write failed; all owned changes were rolled back exactly',
      remediation: 'Re-run setup after resolving the filesystem error.',
    })
  }
}

export function codexDoctor(input: DoctorInput): {
  readonly checks: readonly DoctorCheck[]
  readonly matrix: ReturnType<typeof capabilityMatrix>
} {
  const checks: DoctorCheck[] = []
  const version = checkCodexVersion(input.versionText)
  checks.push({
    id: 'executable-version',
    status: version.status === 'supported' ? 'ok' : 'fail',
    summary:
      version.status === 'supported'
        ? `Codex ${version.detected} is supported.`
        : 'Codex version is not usable.',
    remediation: version.remediation,
  })
  let tomlDocument: Record<string, unknown> | null = null
  let tomlCorrupted = false
  if (input.tomlText === null) {
    checks.push({
      id: 'config-parse',
      status: 'warning',
      summary: 'No Codex config file exists yet.',
      remediation: 'Run setup to create the owned fragments.',
    })
  } else {
    try {
      tomlDocument = parseTomlDocument(input.tomlText)
      checks.push({
        id: 'config-parse',
        status: 'ok',
        summary: 'Codex config parses.',
        remediation: null,
      })
    } catch {
      tomlCorrupted = true
      checks.push({
        id: 'config-parse',
        status: 'fail',
        summary: 'Codex config is corrupted.',
        remediation: 'Restore from a timestamped backup, then re-run setup.',
      })
    }
  }
  let hooksDocument: Record<string, unknown> | null = null
  let hooksCorrupted = false
  if (input.hooksText === null) {
    checks.push({
      id: 'hooks-parse',
      status: 'warning',
      summary: 'No Codex hooks file exists yet.',
      remediation: 'Run setup to create the owned hook entry.',
    })
  } else {
    try {
      hooksDocument = parseHooksJsonDocument(input.hooksText)
      checks.push({
        id: 'hooks-parse',
        status: 'ok',
        summary: 'Codex hooks file parses.',
        remediation: null,
      })
    } catch {
      hooksCorrupted = true
      checks.push({
        id: 'hooks-parse',
        status: 'fail',
        summary: 'Codex hooks file is corrupted.',
        remediation: 'Restore from a timestamped backup, then re-run setup.',
      })
    }
  }
  if (input.tomlText !== null && !tomlCorrupted) {
    try {
      validateHooksTable(
        tomlDocument === null ? undefined : tomlDocument[CODEX_HOOKS_TABLE_KEY],
        'config.toml',
      )
      validateHooksTable(
        hooksDocument === null && input.hooksText !== null
          ? undefined
          : hooksDocument === null
            ? undefined
            : hooksDocument[CODEX_HOOKS_TABLE_KEY],
        'hooks.json',
      )
      const inline = tomlDocument !== null && readHooksTable(tomlDocument) !== null
      const external = hooksDocument !== null && readHooksTable(hooksDocument) !== null
      if (inline && external) {
        checks.push({
          id: 'hook-representation',
          status: 'warning',
          summary: 'Two hook representations exist in one layer.',
          remediation: 'Re-run setup to consolidate owned hooks into one representation.',
        })
      } else {
        checks.push({
          id: 'hook-representation',
          status: 'ok',
          summary: 'One hook representation per layer.',
          remediation: null,
        })
      }
    } catch (error) {
      checks.push({
        id: 'hook-representation',
        status: 'fail',
        summary: 'Hook schema is not recognized.',
        remediation:
          error instanceof CodexAdapterError
            ? `${error.message} ${error.remediation}`
            : 'Repair the config first.',
      })
    }
  }
  if (input.manifest === null) {
    checks.push({
      id: 'owned-entries',
      status: 'warning',
      summary: 'No adapter manifest; setup has not been applied.',
      remediation: 'Run setup to record owned fragments.',
    })
  } else {
    const drift = detectCodexDrift(input.manifest, input.tomlText, input.hooksText)
    checks.push({
      id: 'owned-entries',
      status: drift.status === 'clean' ? 'ok' : drift.status === 'corrupted' ? 'fail' : 'warning',
      summary: `Owned fragments: ${drift.status}.`,
      remediation: drift.status === 'clean' ? null : 'Run remove to repair or re-run setup.',
    })
  }
  if (input.sessionId === null || input.sessionId === undefined || input.sessionId.length === 0) {
    checks.push({
      id: 'selected-session',
      status: 'fail',
      summary: 'No usable Session; covered calls fail closed.',
      remediation: 'Select a Session with `ocbox use <session>` or pass --session explicitly.',
    })
  } else if (!input.sessionRecorded) {
    checks.push({
      id: 'selected-session',
      status: 'fail',
      summary: 'Selected Session is not recorded in lifecycle state.',
      remediation: 'Select an existing Session before routing through the adapter.',
    })
  } else {
    checks.push({
      id: 'selected-session',
      status: 'ok',
      summary: 'A recorded Session is selected for routing.',
      remediation: null,
    })
  }
  checks.push({
    id: 'provider-readiness',
    status: input.sessionRecorded ? 'ok' : 'warning',
    summary: input.sessionRecorded
      ? 'Lifecycle state has the selected Session.'
      : 'Provider readiness is unknown offline without a selected Session.',
    remediation: input.sessionRecorded
      ? null
      : 'Live provider reachability requires a networked check.',
  })
  if (version.status === 'supported' && !tomlCorrupted && !hooksCorrupted) {
    try {
      validateHooksTable(
        tomlDocument === null ? undefined : tomlDocument[CODEX_HOOKS_TABLE_KEY],
        'config.toml',
      )
      validateHooksTable(
        hooksDocument === null ? undefined : hooksDocument[CODEX_HOOKS_TABLE_KEY],
        'hooks.json',
      )
      checks.push({
        id: 'schema-proof',
        status: 'ok',
        summary: `Hook schema matches the pinned Codex ${version.detected} gate.`,
        remediation: null,
      })
    } catch (error) {
      checks.push({
        id: 'schema-proof',
        status: 'fail',
        summary: 'Hook schema is not recognized for the pinned Codex version.',
        remediation:
          error instanceof CodexAdapterError
            ? `${error.message} ${error.remediation}`
            : LIVE_E2E_BLOCKER,
      })
    }
  } else if (version.status !== 'supported') {
    checks.push({
      id: 'schema-proof',
      status: 'fail',
      summary: 'Hook schema cannot be proven on an unsupported Codex version.',
      remediation: version.remediation,
    })
  } else {
    checks.push({
      id: 'schema-proof',
      status: 'warning',
      summary: 'Hook schema cannot be evaluated on corrupted config.',
      remediation: 'Repair the config first.',
    })
  }
  checks.push({
    id: 'recursion-guard',
    status: isRecursionGuardActive(input.environment) ? 'warning' : 'ok',
    summary: isRecursionGuardActive(input.environment)
      ? 'Recursion guard is active; adapter routing is paused in this process.'
      : 'Recursion guard is armed on owned hook commands.',
    remediation: null,
  })
  if (input.trustLevel !== null && input.trustLevel !== 'trusted') {
    checks.push({
      id: 'project-trust',
      status: 'warning',
      summary: 'Repository is not trusted; project hooks are skipped.',
      remediation: 'Trust the repository in Codex first, or use the user layer.',
    })
  }
  void CODEX_ADAPTER_VERSION
  return { checks, matrix: capabilityMatrix() }
}

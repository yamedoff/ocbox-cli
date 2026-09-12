import { capabilityMatrix } from './capabilities.js'
import {
  buildOwnedHookEntry,
  hasOwnedHook,
  mergeOwnedHooks,
  parseHooksJson,
  removeOwnedHooks,
  serializeHooksJson,
  type HooksFileDocument,
} from './hooks-file.js'
import { buildHookArgv, HOOK_OWNED_ID, isRecursionGuardActive } from './hook-helper.js'
import {
  inlineHooksPresent,
  mergeOwnedToml,
  ownedTomlFragment,
  parseCodexToml,
  readOwnedToml,
  serializeCodexToml,
  stripOwnedToml,
} from './toml-merge.js'
import { CODEX_ADAPTER_VERSION } from './manifest.js'
import type { CodexManifest } from './manifest.js'
import { layerTargetFiles, type CodexLayer, type CodexPaths } from './paths.js'
import { checkCodexVersion, LIVE_E2E_BLOCKER } from './version.js'

export interface SetupPlanInput {
  readonly versionText: string
  readonly layer: CodexLayer
  readonly trustLevel: string | null
  readonly sessionId: string | null | undefined
  readonly allowUnverifiedSchema: boolean
  readonly paths: CodexPaths
  readonly baseTomlText: string | null
  readonly baseHooksText: string | null
  readonly ocboxBin?: string | undefined
}

export interface PlannedFileChange {
  readonly file: string
  readonly kind: 'toml-merge' | 'hooks-write'
  readonly before: string | null
  readonly after: string
  readonly representation: string
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
}

export interface DriftReport {
  readonly status: 'clean' | 'drifted' | 'corrupted' | 'missing' | 'no-manifest'
  readonly details: readonly string[]
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
}

export interface RemovePlan {
  readonly ok: boolean
  readonly actions: readonly RemoveFileAction[]
  readonly repairSteps: readonly string[]
  readonly warnings: readonly string[]
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

function normalizeNewlines(text: string): string {
  return text.replaceAll('\r\n', '\n')
}

function expectedTexts(input: SetupPlanInput): { toml: string; hooks: string } {
  const sessionId = input.sessionId ?? ''
  const fragment = ownedTomlFragment({
    adapterVersion: CODEX_ADAPTER_VERSION,
    codexVersion: input.versionText,
    layer: input.layer,
    sessionId,
    hookId: HOOK_OWNED_ID,
    hookRepresentation: 'hooks-json',
  })
  const baseToml = input.baseTomlText === null ? {} : parseCodexToml(input.baseTomlText)
  const toml = serializeCodexToml(mergeOwnedToml(baseToml, fragment))
  const existing: HooksFileDocument | null =
    input.baseHooksText === null ? null : parseHooksJson(input.baseHooksText)
  const hooks = serializeHooksJson(
    mergeOwnedHooks(
      existing,
      buildOwnedHookEntry(sessionId, buildHookArgv({ sessionId, ocboxBin: input.ocboxBin })),
    ),
  )
  return { toml, hooks }
}

export function planCodexSetup(input: SetupPlanInput, manifest?: CodexManifest | null): SetupPlan {
  const errors: string[] = []
  const warnings: string[] = []
  const version = checkCodexVersion(input.versionText)
  const targets = layerTargetFiles(input.paths, input.layer)
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
  let baseToml: Record<string, unknown> | null = null
  if (input.baseTomlText !== null) {
    try {
      baseToml = parseCodexToml(input.baseTomlText)
    } catch {
      errors.push(
        'Codex config is corrupted (unparseable TOML); refusing to merge. Restore from a backup or remove the damage, then retry.',
      )
    }
  }
  if (input.baseHooksText !== null) {
    try {
      parseHooksJson(input.baseHooksText)
    } catch {
      errors.push(
        'Codex hooks file is corrupted (unparseable JSON); refusing to merge. Restore from a backup or remove the damage, then retry.',
      )
    }
  }
  if (baseToml !== null && inlineHooksPresent(baseToml) && input.baseHooksText !== null) {
    errors.push(
      'Two hook representations exist in one layer (inline TOML hooks plus hooks.json); keeping one representation per layer is required. Remove one before setup.',
    )
  }
  if (!input.allowUnverifiedSchema) {
    errors.push(
      'The hook/config schema for the pinned Codex version is unverified locally; setup stays fail-closed. Re-run with --allow-unverified-schema to apply the documented fixture representation at your own risk.',
    )
  }
  warnings.push(
    'The Codex adapter is a routing aid, not host isolation and not a security boundary.',
  )
  if (errors.length > 0) {
    return {
      ok: false,
      detectedVersion: version.detected,
      layer: input.layer,
      configFile: targets.configFile,
      hooksFile: targets.hooksFile,
      projectTrusted,
      errors,
      warnings,
      changes: [],
      alreadyApplied: false,
      liveBlocker: LIVE_E2E_BLOCKER,
    }
  }
  const expected = expectedTexts(input)
  const currentTomlNorm = input.baseTomlText === null ? null : normalizeNewlines(input.baseTomlText)
  const currentHooksNorm =
    input.baseHooksText === null ? null : normalizeNewlines(input.baseHooksText)
  const manifestMatches =
    manifest !== null &&
    manifest !== undefined &&
    manifest.layer === input.layer &&
    manifest.sessionId === input.sessionId &&
    manifest.configFile === targets.configFile &&
    manifest.hooksFile === targets.hooksFile &&
    normalizeNewlines(manifest.ownedTomlText) === normalizeNewlines(expected.toml) &&
    normalizeNewlines(manifest.ownedHooksText) === normalizeNewlines(expected.hooks)
  if (
    manifestMatches &&
    currentTomlNorm === normalizeNewlines(expected.toml) &&
    currentHooksNorm === normalizeNewlines(expected.hooks)
  ) {
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
    }
  }
  const changes: PlannedFileChange[] = []
  if (currentTomlNorm !== normalizeNewlines(expected.toml)) {
    changes.push({
      file: targets.configFile,
      kind: 'toml-merge',
      before: input.baseTomlText,
      after: expected.toml,
      representation: 'toml-owned-table',
    })
  }
  if (currentHooksNorm !== normalizeNewlines(expected.hooks)) {
    changes.push({
      file: targets.hooksFile,
      kind: 'hooks-write',
      before: input.baseHooksText,
      after: expected.hooks,
      representation: 'hooks-json',
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
  }
}

export function detectCodexDrift(
  manifest: CodexManifest | null,
  currentTomlText: string | null,
  currentHooksText: string | null,
): DriftReport {
  if (manifest === null) return { status: 'no-manifest', details: ['No adapter manifest exists.'] }
  const details: string[] = []
  if (currentTomlText !== null) {
    try {
      const document = parseCodexToml(currentTomlText)
      const owned = readOwnedToml(document)
      if (owned === null) details.push('Owned TOML table is missing.')
      else if (normalizeNewlines(currentTomlText) !== normalizeNewlines(manifest.ownedTomlText)) {
        details.push('Config file differs from the manifest-owned text.')
      }
    } catch {
      return { status: 'corrupted', details: ['Config file is unparseable TOML.'] }
    }
  } else {
    details.push('Config file is missing.')
  }
  if (currentHooksText !== null) {
    try {
      const document = parseHooksJson(currentHooksText)
      if (!hasOwnedHook(document)) details.push('Owned hook entry is missing.')
      else if (normalizeNewlines(currentHooksText) !== normalizeNewlines(manifest.ownedHooksText)) {
        details.push('Hooks file differs from the manifest-owned text.')
      }
    } catch {
      return { status: 'corrupted', details: ['Hooks file is unparseable JSON.'] }
    }
  } else {
    details.push('Hooks file is missing.')
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
    }
  }
  const manifest = input.manifest
  const tomlExpected = normalizeNewlines(manifest.ownedTomlText)
  const hooksExpected = normalizeNewlines(manifest.ownedHooksText)
  const currentToml =
    input.currentTomlText === null ? null : normalizeNewlines(input.currentTomlText)
  const currentHooks =
    input.currentHooksText === null ? null : normalizeNewlines(input.currentHooksText)
  const originalToml =
    input.originalTomlText === null ? null : normalizeNewlines(input.originalTomlText)
  const originalHooks =
    input.originalHooksText === null ? null : normalizeNewlines(input.originalHooksText)

  if (currentToml === null) {
    actions.push({
      file: manifest.configFile,
      action: 'noop',
      after: null,
      preservedCopy: null,
      detail: 'Config file already absent.',
    })
  } else if (currentToml === tomlExpected) {
    if (originalToml === null) {
      const document = parseCodexToml(input.currentTomlText ?? '')
      const stripped = serializeCodexToml(stripOwnedToml(document))
      const empty = Object.keys(parseCodexToml(stripped)).length === 0
      actions.push({
        file: manifest.configFile,
        action: empty ? 'delete' : 'strip-owned',
        after: empty ? null : stripped,
        preservedCopy: null,
        detail: 'Config matches the manifest; removing only owned fragments.',
      })
    } else {
      actions.push({
        file: manifest.configFile,
        action: 'restore',
        after: input.originalTomlText,
        preservedCopy: null,
        detail: 'Config matches the manifest; restoring the timestamped backup.',
      })
    }
  } else if (originalToml !== null && currentToml === originalToml) {
    actions.push({
      file: manifest.configFile,
      action: 'noop',
      after: input.currentTomlText,
      preservedCopy: null,
      detail: 'Config already equals the pre-setup backup.',
    })
  } else {
    const preserved = `${manifest.configFile}.ocbox-preserved`
    const fallback =
      originalToml ??
      serializeCodexToml(stripOwnedToml(parseCodexToml(input.currentTomlText ?? '')))
    actions.push({
      file: manifest.configFile,
      action: 'preserve-and-plan',
      after: fallback,
      preservedCopy: preserved,
      detail: 'Config was edited after setup; preserving the current copy before restoring.',
    })
    repairSteps.push(
      `Config file drifted: copy the current file to ${preserved}, restore the backup content, then re-run doctor.`,
    )
    warnings.push('User edits detected in the config file; both copies are preserved.')
  }

  if (currentHooks === null) {
    actions.push({
      file: manifest.hooksFile,
      action: 'noop',
      after: null,
      preservedCopy: null,
      detail: 'Hooks file already absent.',
    })
  } else if (currentHooks === hooksExpected) {
    if (originalHooks === null) {
      const { document } = removeOwnedHooks(parseHooksJson(input.currentHooksText ?? ''))
      const empty = document.hooks.length === 0
      actions.push({
        file: manifest.hooksFile,
        action: empty ? 'delete' : 'strip-owned',
        after: empty ? null : serializeHooksJson(document),
        preservedCopy: null,
        detail: 'Hooks file matches the manifest; removing only the owned entry.',
      })
    } else {
      actions.push({
        file: manifest.hooksFile,
        action: 'restore',
        after: input.originalHooksText,
        preservedCopy: null,
        detail: 'Hooks file matches the manifest; restoring the timestamped backup.',
      })
    }
  } else if (originalHooks !== null && currentHooks === originalHooks) {
    actions.push({
      file: manifest.hooksFile,
      action: 'noop',
      after: input.currentHooksText,
      preservedCopy: null,
      detail: 'Hooks file already equals the pre-setup backup.',
    })
  } else {
    const preserved = `${manifest.hooksFile}.ocbox-preserved`
    const fallback =
      originalHooks ??
      serializeHooksJson(removeOwnedHooks(parseHooksJson(input.currentHooksText ?? '')).document)
    actions.push({
      file: manifest.hooksFile,
      action: 'preserve-and-plan',
      after: fallback,
      preservedCopy: preserved,
      detail: 'Hooks file was edited after setup; preserving the current copy before restoring.',
    })
    repairSteps.push(
      `Hooks file drifted: copy the current file to ${preserved}, restore the backup content, then re-run doctor.`,
    )
    warnings.push('User edits detected in the hooks file; both copies are preserved.')
  }
  return { ok: true, actions, repairSteps, warnings }
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
  if (input.tomlText === null) {
    checks.push({
      id: 'config-parse',
      status: 'warning',
      summary: 'No Codex config file exists yet.',
      remediation: 'Run setup to create the owned fragments.',
    })
  } else {
    try {
      parseCodexToml(input.tomlText)
      checks.push({
        id: 'config-parse',
        status: 'ok',
        summary: 'Codex config parses.',
        remediation: null,
      })
    } catch {
      checks.push({
        id: 'config-parse',
        status: 'fail',
        summary: 'Codex config is corrupted.',
        remediation: 'Restore from a timestamped backup, then re-run setup.',
      })
    }
  }
  if (input.hooksText === null) {
    checks.push({
      id: 'hooks-parse',
      status: 'warning',
      summary: 'No Codex hooks file exists yet.',
      remediation: 'Run setup to create the owned hook entry.',
    })
  } else {
    try {
      parseHooksJson(input.hooksText)
      checks.push({
        id: 'hooks-parse',
        status: 'ok',
        summary: 'Codex hooks file parses.',
        remediation: null,
      })
    } catch {
      checks.push({
        id: 'hooks-parse',
        status: 'fail',
        summary: 'Codex hooks file is corrupted.',
        remediation: 'Restore from a timestamped backup, then re-run setup.',
      })
    }
  }
  if (input.tomlText !== null) {
    try {
      const inline = inlineHooksPresent(parseCodexToml(input.tomlText))
      if (inline && input.hooksText !== null) {
        checks.push({
          id: 'hook-representation',
          status: 'fail',
          summary: 'Two hook representations exist in one layer.',
          remediation: 'Keep exactly one representation per layer before setup.',
        })
      } else {
        checks.push({
          id: 'hook-representation',
          status: 'ok',
          summary: 'One hook representation per layer.',
          remediation: null,
        })
      }
    } catch {
      checks.push({
        id: 'hook-representation',
        status: 'fail',
        summary: 'Cannot evaluate hook representation on corrupted config.',
        remediation: 'Repair the config first.',
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
  checks.push({
    id: 'schema-proof',
    status: 'warning',
    summary: 'Hook/config schema is unverified locally for the pinned Codex version.',
    remediation: LIVE_E2E_BLOCKER,
  })
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
  return { checks, matrix: capabilityMatrix() }
}

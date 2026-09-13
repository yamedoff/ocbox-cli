import { CAPABILITY_MATRIX, ROUTING_AID_NOTICE } from './capabilities.js'
import { detectDrift, planMerge, planRemove as planRemoveEntries, sha256Json } from './merge.js'
import {
  type ClaudeSettingsDocument,
  collectDenyAskRules,
  hasManagedHookLock,
  OWNED_PERMISSION_ALLOW,
  parseSettingsJson,
} from './settings-model.js'
import type { AdapterScope, ClaudeSettingsLayout } from './settings-sources.js'
import { targetPathForScope } from './settings-sources.js'
import {
  backupPathForTarget,
  hashDocument,
  MANIFEST_FILENAME,
  manifestPathForTarget,
  type OwnedManifest,
  parseManifestContent,
  readTextIfPresent,
  writeFileAtomic,
} from './store.js'
import { gateClaudeVersion, PINNED_CLAUDE_CODE_VERSION } from './version.js'

export interface PlannerFileAccess {
  readonly readText: (path: string) => Promise<string | null>
  readonly writeText: (path: string, content: string) => Promise<void>
  readonly removePath?: (path: string) => Promise<void>
  readonly now?: () => Date
}

export interface PlannerOptions {
  readonly layout: ClaudeSettingsLayout
  readonly scope: AdapterScope
  readonly sessionId: string | null
  readonly claudeVersionRaw: string
  readonly files: PlannerFileAccess
}

export interface SetupResult {
  readonly status: 'applied' | 'already-applied'
  readonly targetPath: string
  readonly backupPath: string | null
  readonly manifestPath: string
  readonly sessionId: string | null
  readonly pinnedVersion: typeof PINNED_CLAUDE_CODE_VERSION
  readonly protectedRules: readonly string[]
}

export interface DoctorFinding {
  readonly check: string
  readonly ok: boolean
  readonly detail: string
}

export interface DoctorResult {
  readonly ok: boolean
  readonly targetPath: string
  readonly findings: readonly DoctorFinding[]
  readonly capabilityMatrix: typeof CAPABILITY_MATRIX
  readonly notice: string
}

export interface RemoveResult {
  readonly status: 'removed' | 'not-installed'
  readonly targetPath: string
  readonly repairPlan: readonly string[]
  readonly conflicts: readonly string[]
}

function stableStringify(document: ClaudeSettingsDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

async function rollbackTarget(
  files: PlannerFileAccess,
  targetPath: string,
  baseRaw: string | null,
): Promise<void> {
  if (baseRaw === null) {
    if (files.removePath !== undefined) await files.removePath(targetPath).catch(() => undefined)
    return
  }
  await files.writeText(targetPath, baseRaw).catch(() => undefined)
}

async function loadDocument(
  files: PlannerFileAccess,
  path: string,
): Promise<{
  readonly raw: string | null
  readonly document: ClaudeSettingsDocument
  readonly issues: string[]
}> {
  const raw = await files.readText(path)
  const parsed = parseSettingsJson(path, raw)
  return { raw, document: parsed.document, issues: parsed.issues.map((issue) => issue.message) }
}

function higherPolicyGuard(
  paths: readonly { readonly label: string; readonly raw: string | null }[],
): {
  readonly deny: string[]
  readonly ask: string[]
} {
  const deny: string[] = []
  const ask: string[] = []
  for (const entry of paths) {
    if (entry.raw === null) continue
    const parsed = parseSettingsJson(entry.label, entry.raw)
    if (parsed.issues.length > 0) continue
    if (hasManagedHookLock(parsed.document)) {
      throw new Error(
        'Managed policy locks hooks or permission rules (allowManagedHooksOnly / allowManagedPermissionRulesOnly). Setup refuses to weaken higher policy; ask the workspace administrator.',
      )
    }
    const rules = collectDenyAskRules(parsed.document)
    if (rules.deny.some((rule) => rule.startsWith('Bash('))) {
      throw new Error(
        'Managed policy denies Bash rules that overlap the owned router. Setup fails closed rather than fighting higher policy.',
      )
    }
    deny.push(...rules.deny)
    ask.push(...rules.ask)
  }
  return { deny, ask }
}

export async function planSetup(options: PlannerOptions): Promise<SetupResult> {
  const gate = gateClaudeVersion(options.claudeVersionRaw)
  if (!gate.supported) throw new Error(gate.remediation)
  const targetPath = targetPathForScope(options.layout, options.scope)
  const higherPaths: { readonly label: string; readonly raw: string | null }[] = []
  if (options.layout.managedSettingsPath !== null) {
    higherPaths.push({
      label: options.layout.managedSettingsPath,
      raw: await options.files.readText(options.layout.managedSettingsPath),
    })
  }
  for (const explicit of options.layout.explicitSettingsPaths) {
    higherPaths.push({ label: explicit, raw: await options.files.readText(explicit) })
  }
  const higher = higherPolicyGuard(higherPaths)
  const current = await loadDocument(options.files, targetPath)
  if (current.issues.length > 0) {
    throw new Error(`Target settings failed validation: ${current.issues.join('; ')}`)
  }
  const manifestPath = manifestPathForTarget(targetPath)
  const merged = planMerge(current.document, options.sessionId, {
    higherDeny: higher.deny,
    higherAsk: higher.ask,
  })
  if (merged.protectedRules.length > 0) {
    throw new Error(
      `Higher-precedence policy shadows the owned router (${merged.protectedRules.join(', ')}). Setup fails closed rather than weakening ${higherPaths.length > 0 ? 'managed/explicit' : 'higher'} policy.`,
    )
  }
  if (merged.alreadyApplied) {
    return {
      status: 'already-applied',
      targetPath,
      backupPath: null,
      manifestPath,
      sessionId: options.sessionId,
      pinnedVersion: PINNED_CLAUDE_CODE_VERSION,
      protectedRules: merged.protectedRules,
    }
  }
  let backupPath: string | null = null
  if (current.raw !== null) {
    backupPath = backupPathForTarget(targetPath, options.files.now?.() ?? new Date())
    await options.files.writeText(backupPath, current.raw)
  }
  const nextManifest: OwnedManifest = {
    adapter: 'claude-code',
    pinnedVersion: PINNED_CLAUDE_CODE_VERSION,
    targetPath,
    baseHash: sha256Json(current.document),
    appliedHash: hashDocument(merged.document),
    desiredHash: hashDocument(merged.document),
    sessionId: options.sessionId,
    updatedAt: (options.files.now?.() ?? new Date()).toISOString(),
    backupPath,
    createdPointers: merged.createdPointers,
    protectedRules: merged.protectedRules,
  }
  try {
    await options.files.writeText(targetPath, stableStringify(merged.document))
    await options.files.writeText(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`)
  } catch (error) {
    await rollbackTarget(options.files, targetPath, current.raw)
    throw error
  }
  return {
    status: 'applied',
    targetPath,
    backupPath,
    manifestPath,
    sessionId: options.sessionId,
    pinnedVersion: PINNED_CLAUDE_CODE_VERSION,
    protectedRules: merged.protectedRules,
  }
}

export async function planDoctor(options: PlannerOptions): Promise<DoctorResult> {
  const findings: DoctorFinding[] = []
  const gate = gateClaudeVersion(options.claudeVersionRaw)
  findings.push({
    check: 'executable-version',
    ok: gate.supported,
    detail: gate.supported
      ? `claude ${gate.installed} matches pinned ${gate.pinned}`
      : gate.remediation,
  })
  const targetPath = targetPathForScope(options.layout, options.scope)
  const ordered: Array<{ readonly source: string; readonly path: string | null }> = [
    { source: 'managed', path: options.layout.managedSettingsPath },
    ...options.layout.explicitSettingsPaths.map((path) => ({ source: 'explicit', path })),
    { source: 'local-project', path: options.layout.localProjectSettingsPath },
    { source: 'shared-project', path: options.layout.sharedProjectSettingsPath },
    { source: 'user', path: options.layout.userSettingsPath },
  ]
  let corrupt = false
  for (const entry of ordered) {
    if (entry.path === null) {
      findings.push({
        check: `settings-${entry.source}`,
        ok: true,
        detail: `${entry.source} source has no path on this platform`,
      })
      continue
    }
    const raw = await options.files.readText(entry.path)
    if (raw === null) {
      findings.push({
        check: `settings-${entry.source}`,
        ok: true,
        detail: `${entry.source} absent at ${entry.path}`,
      })
      continue
    }
    const parsed = parseSettingsJson(entry.path, raw)
    if (parsed.issues.length > 0) {
      corrupt = true
      findings.push({
        check: `settings-${entry.source}`,
        ok: false,
        detail: `${entry.source} invalid: ${parsed.issues.map((issue) => issue.message).join('; ')}`,
      })
    } else {
      const { deny, ask } = collectDenyAskRules(parsed.document)
      findings.push({
        check: `settings-${entry.source}`,
        ok: true,
        detail: `${entry.source} parses; deny=${deny.length} ask=${ask.length}; deny-first precedence preserved`,
      })
    }
  }
  const current = await loadDocument(options.files, targetPath)
  if (current.issues.length > 0) {
    findings.push({
      check: 'owned-entries',
      ok: false,
      detail: `target invalid: ${current.issues.join('; ')}`,
    })
  } else {
    const merged = planMerge(current.document, options.sessionId)
    findings.push({
      check: 'owned-entries',
      ok: merged.alreadyApplied,
      detail: merged.alreadyApplied
        ? `owned PreToolUse Bash hook and ${OWNED_PERMISSION_ALLOW} rule present under the hooks key at ${targetPath}`
        : `owned entries missing at ${targetPath}; run setup`,
    })
    const manifestPath = manifestPathForTarget(targetPath)
    const manifestRaw = await options.files.readText(manifestPath)
    if (manifestRaw === null) {
      findings.push({
        check: 'manifest',
        ok: false,
        detail: `owned manifest missing at ${manifestPath}`,
      })
    } else {
      findings.push({
        check: 'manifest',
        ok: true,
        detail: `owned manifest present at ${manifestPath}`,
      })
      try {
        const manifest = JSON.parse(manifestRaw) as OwnedManifest
        const drift = detectDrift(
          JSON.parse(JSON.stringify({})) as ClaudeSettingsDocument,
          current.document,
        )
        void drift
        if (
          manifest.baseHash !== sha256Json(current.document) &&
          manifest.appliedHash !== hashDocument(current.document)
        ) {
          findings.push({
            check: 'drift',
            ok: false,
            detail:
              'target differs from both manifest base and applied snapshots; user edits preserved, run remove for a three-way repair plan',
          })
        } else if (manifest.appliedHash !== hashDocument(current.document)) {
          findings.push({
            check: 'drift',
            ok: false,
            detail: 'owned entries changed after apply; repair plan available via remove',
          })
        } else {
          findings.push({
            check: 'drift',
            ok: true,
            detail: 'target matches the applied manifest snapshot',
          })
        }
      } catch {
        findings.push({
          check: 'drift',
          ok: false,
          detail: `manifest at ${manifestPath} is corrupt; back up target before repairing`,
        })
      }
    }
  }
  findings.push({
    check: 'session',
    ok: options.sessionId !== null && options.sessionId.length > 0,
    detail:
      options.sessionId !== null && options.sessionId.length > 0
        ? `selected Session ${options.sessionId}; covered Bash calls route through ocbox exec`
        : 'no usable selected Session; covered Bash calls fail closed (blocked, exit 2) until a Session is selected',
  })
  findings.push({
    check: 'routing-boundary',
    ok: true,
    detail:
      'covered: Bash via PreToolUse + explicit ocbox sync. uncovered stays local: Edit/Write/Read/Glob/Grep/WebFetch/WebSearch/MCP/subagents/IDE. See capabilityMatrix.',
  })
  if (corrupt) {
    findings.push({
      check: 'corruption',
      ok: false,
      detail: `settings corruption detected; never edit ${MANIFEST_FILENAME} by hand`,
    })
  }
  const ok = findings.every((finding) => finding.ok || finding.check === 'routing-boundary')
  return {
    ok,
    targetPath,
    findings,
    capabilityMatrix: CAPABILITY_MATRIX,
    notice: ROUTING_AID_NOTICE,
  }
}

export async function planRemove(options: PlannerOptions): Promise<RemoveResult> {
  const targetPath = targetPathForScope(options.layout, options.scope)
  const current = await loadDocument(options.files, targetPath)
  if (current.issues.length > 0) {
    return {
      status: 'not-installed',
      targetPath,
      repairPlan: [
        `target ${targetPath} is invalid: ${current.issues.join('; ')}`,
        'restore the newest .ocbox-backup-*.json by hand, then re-run doctor; owned entries were not touched',
      ],
      conflicts: [],
    }
  }
  const manifestPath = manifestPathForTarget(targetPath)
  const manifestRaw = await options.files.readText(manifestPath)
  const manifest = parseManifestContent(manifestRaw)
  const removed = planRemoveEntries(current.document, manifest?.createdPointers ?? [])
  if (removed.removedHooks === 0 && removed.removedPermissions === 0 && !removed.changed) {
    return { status: 'not-installed', targetPath, repairPlan: [], conflicts: [] }
  }
  const conflicts = removed.conflicts.map((conflict) => conflict.pointer)
  const repairPlan: string[] = []
  if (manifestRaw !== null) {
    try {
      const parsed = JSON.parse(manifestRaw) as OwnedManifest
      if (parsed.appliedHash !== hashDocument(current.document)) {
        repairPlan.push(
          'three-way repair: base=manifest baseHash, current=target file, desired=current minus owned entries',
          'user edits around owned entries are preserved; only exact owned hook and permission matches were removed',
          `conflicting target kept at ${targetPath}; newest .ocbox-backup-*.json remains available for manual diff`,
        )
      }
    } catch {
      repairPlan.push(
        `manifest at ${manifestPath} is corrupt; owned matches removed, manual review recommended`,
      )
    }
  }
  if (conflicts.length > 0) {
    repairPlan.push(
      `container-invalid at ${conflicts.join(', ')}: user replaced an owned container with a different type; left untouched for manual review`,
    )
  }
  try {
    await options.files.writeText(targetPath, stableStringify(removed.document))
  } catch (error) {
    await rollbackTarget(options.files, targetPath, current.raw)
    throw error
  }
  return { status: 'removed', targetPath, repairPlan, conflicts }
}

export function liveFileAccess(): PlannerFileAccess {
  return {
    readText: readTextIfPresent,
    writeText: writeFileAtomic,
  }
}

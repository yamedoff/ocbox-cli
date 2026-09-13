import { SessionIdSchema } from '../../contracts.js'
import { CAPABILITY_MATRIX, ROUTING_AID_NOTICE } from './capabilities.js'
import { planMerge, planRemove as planRemoveEntries, sha256Json } from './merge.js'
import {
  type ClaudeSettingsDocument,
  collectDenyAskRules,
  hasManagedHookLock,
  OWNED_PERMISSION_ALLOW,
  parseSettingsJson,
  permissionRulesOverlap,
} from './settings-model.js'
import type {
  AdapterScope,
  ClaudeSettingsLayout,
  ClaudeSettingsSource,
} from './settings-sources.js'
import {
  precedenceRank,
  resolveClaudeSettingsSources,
  scopeToSourceKind,
  targetPathForScope,
} from './settings-sources.js'
import {
  backupPathForTarget,
  hashDocument,
  MANIFEST_FILENAME,
  manifestPathForTarget,
  type OwnedManifest,
  parseManifestContent,
  readTextIfPresent,
  removePathIfPresent,
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

/**
 * The selected Session is embedded verbatim into the installed hook command and
 * later parsed by the strict `ocbox exec` grammar. Validate it with the
 * canonical id schema up front so a mistyped id can never be installed (which
 * would make the hook fail open at route time) or reported healthy by doctor.
 */
export function selectedSessionIssue(sessionId: string | null): string | null {
  if (sessionId === null) return null
  if (SessionIdSchema.safeParse(sessionId).success) return null
  return `Selected Session "${sessionId}" is not a valid Session ID (expected a UUID or ULID); run "ocbox session list" and re-run with a real --session value`
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

interface PolicyLock {
  readonly kind: ClaudeSettingsSource
  readonly path: string
}

interface PolicyShadow {
  readonly kind: ClaudeSettingsSource
  readonly path: string
  readonly rule: string
  readonly polarity: 'deny' | 'ask'
}

interface PolicyEvaluation {
  readonly locks: readonly PolicyLock[]
  readonly shadowing: readonly PolicyShadow[]
  readonly deny: readonly string[]
  readonly ask: readonly string[]
}

// Read-only evaluation of every applicable settings source. Claude Code unions
// deny/ask rules across all settings sources and evaluates them deny-first, so a
// rule from a source ranked below the target still shadows the owned allow; the
// PreToolUse hook fires before permission evaluation, so the command would route
// remotely before the local deny/ask applied. Locks are a different concept: they
// are a managed-policy gate, so they are honored only from sources at or above
// the target. Write precedence governs which source the adapter may write, not
// whether a rule blocks.
async function evaluatePolicy(
  files: PlannerFileAccess,
  layout: ClaudeSettingsLayout,
  scope: AdapterScope,
): Promise<PolicyEvaluation> {
  const targetRank = precedenceRank(scopeToSourceKind(scope))
  const sources = resolveClaudeSettingsSources(layout)
  const locks: PolicyLock[] = []
  const shadowing: PolicyShadow[] = []
  const deny: string[] = []
  const ask: string[] = []
  for (const source of sources) {
    const raw = await files.readText(source.path)
    if (raw === null) continue
    const parsed = parseSettingsJson(source.path, raw)
    if (parsed.issues.length > 0) continue
    if (source.precedence <= targetRank && hasManagedHookLock(parsed.document)) {
      locks.push({ kind: source.kind, path: source.path })
    }
    const rules = collectDenyAskRules(parsed.document)
    for (const rule of rules.deny) {
      deny.push(rule)
      if (permissionRulesOverlap(rule, OWNED_PERMISSION_ALLOW)) {
        shadowing.push({ kind: source.kind, path: source.path, rule, polarity: 'deny' })
      }
    }
    for (const rule of rules.ask) {
      ask.push(rule)
      if (permissionRulesOverlap(rule, OWNED_PERMISSION_ALLOW)) {
        shadowing.push({ kind: source.kind, path: source.path, rule, polarity: 'ask' })
      }
    }
  }
  return { locks, shadowing, deny, ask }
}

function describeShadow(shadow: PolicyShadow): string {
  return `${shadow.polarity} "${shadow.rule}" from ${shadow.kind} (${shadow.path})`
}

function managedLockError(locks: readonly PolicyLock[]): Error {
  return new Error(
    `Managed policy locks hooks or permission rules (allowManagedHooksOnly / allowManagedPermissionRulesOnly) in ${locks
      .map((lock) => `${lock.kind} (${lock.path})`)
      .join(', ')}. Setup refuses to weaken higher policy; ask the workspace administrator.`,
  )
}

function shadowedRouterError(shadowing: readonly PolicyShadow[]): Error {
  const rules = shadowing.map(describeShadow).join(', ')
  return new Error(
    `A deny/ask rule from a settings source shadows the owned router (${rules}). Claude Code unions deny/ask rules across all settings sources and evaluates them before the allow, so setup fails closed rather than installing a hook that would execute remotely before the deny/ask is evaluated.`,
  )
}

function protectedRulesError(rules: readonly string[]): Error {
  return new Error(
    `Higher-precedence policy or container conflicts protect the owned router (${rules.join(', ')}). Setup fails closed rather than weakening higher policy or overwriting user containers.`,
  )
}

export async function planSetup(options: PlannerOptions): Promise<SetupResult> {
  const gate = gateClaudeVersion(options.claudeVersionRaw)
  if (!gate.supported) throw new Error(gate.remediation)
  const sessionIssue = selectedSessionIssue(options.sessionId)
  if (sessionIssue !== null) throw new Error(sessionIssue)
  const targetPath = targetPathForScope(options.layout, options.scope)
  const current = await loadDocument(options.files, targetPath)
  if (current.issues.length > 0) {
    throw new Error(`Target settings failed validation: ${current.issues.join('; ')}`)
  }
  const policy = await evaluatePolicy(options.files, options.layout, options.scope)
  if (policy.locks.length > 0) throw managedLockError(policy.locks)
  if (policy.shadowing.length > 0) throw shadowedRouterError(policy.shadowing)
  const manifestPath = manifestPathForTarget(targetPath)
  const existingManifest = parseManifestContent(await options.files.readText(manifestPath))
  const merged = planMerge(current.document, options.sessionId, {
    higherDeny: policy.deny,
    higherAsk: policy.ask,
  })
  if (merged.protectedRules.length > 0) throw protectedRulesError(merged.protectedRules)
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
  const carriedPointers = existingManifest?.createdPointers ?? []
  const nextManifest: OwnedManifest = {
    adapter: 'claude-code',
    pinnedVersion: PINNED_CLAUDE_CODE_VERSION,
    targetPath,
    baseHash: existingManifest?.baseHash ?? sha256Json(current.document),
    appliedHash: hashDocument(merged.document),
    desiredHash: hashDocument(merged.document),
    sessionId: options.sessionId,
    updatedAt: (options.files.now?.() ?? new Date()).toISOString(),
    backupPath,
    createdPointers: [...new Set([...carriedPointers, ...merged.createdPointers])],
    protectedRules: merged.protectedRules,
    createdFile: existingManifest?.createdFile ?? current.raw === null,
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
  const policy = await evaluatePolicy(options.files, options.layout, options.scope)
  const lockedSources = policy.locks.map((lock) => `${lock.kind} (${lock.path})`).join(', ')
  const shadowingRules = policy.shadowing.map(describeShadow).join(', ')
  if (policy.locks.length > 0) {
    findings.push({
      check: 'managed-lock',
      ok: false,
      detail: `managed policy locks hooks/permissions (allowManagedHooksOnly / allowManagedPermissionRulesOnly) in ${lockedSources}; setup stays blocked until a workspace administrator relaxes the lock`,
    })
  } else {
    findings.push({
      check: 'managed-lock',
      ok: true,
      detail:
        'no allowManagedHooksOnly/allowManagedPermissionRulesOnly lock in sources at or above target precedence',
    })
  }
  if (policy.shadowing.length > 0) {
    findings.push({
      check: 'higher-policy-shadow',
      ok: false,
      detail: `deny/ask rules from settings sources shadow the owned router (${shadowingRules}); setup fails closed because the PreToolUse hook runs before local permission evaluation and deny/ask are unioned across sources, so an administrator must remove or narrow the rule`,
    })
  } else {
    findings.push({
      check: 'higher-policy-shadow',
      ok: true,
      detail:
        'no deny/ask rule from any settings source shadows the owned router (deny/ask are unioned across all sources)',
    })
  }
  let installedSessionId: string | null = null
  let sessionMismatch = false
  const current = await loadDocument(options.files, targetPath)
  if (current.issues.length > 0) {
    findings.push({
      check: 'owned-entries',
      ok: false,
      detail: `target invalid: ${current.issues.join('; ')}`,
    })
  } else {
    const merged = planMerge(current.document, options.sessionId)
    installedSessionId = merged.installedSessionId
    sessionMismatch = merged.ownedHookPresent && merged.installedSessionId !== options.sessionId
    const manifestPath = manifestPathForTarget(targetPath)
    const manifestRaw = await options.files.readText(manifestPath)
    if (merged.ownedHookPresent && merged.ownedPermissionPresent) {
      findings.push({
        check: 'owned-entries',
        ok: true,
        detail: `owned PreToolUse Bash hook and ${OWNED_PERMISSION_ALLOW} rule present under the hooks key at ${targetPath}`,
      })
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
    } else if (!merged.ownedHookPresent && !merged.ownedPermissionPresent) {
      findings.push({
        check: 'owned-entries',
        ok: true,
        detail: `owned entries absent at ${targetPath}; adapter reports a removed state`,
      })
      findings.push({
        check: 'manifest',
        ok: true,
        detail:
          manifestRaw === null
            ? `no owned manifest at ${manifestPath}; adapter is removed`
            : `stale manifest at ${manifestPath} with no owned entries; treated as removed`,
      })
    } else {
      findings.push({
        check: 'owned-entries',
        ok: false,
        detail: `partial adapter state at ${targetPath} (${merged.ownedHookPresent ? 'hook present, permission missing' : 'permission present, hook missing'}); run setup or remove`,
      })
      findings.push({
        check: 'manifest',
        ok: manifestRaw !== null,
        detail:
          manifestRaw === null
            ? `owned manifest missing at ${manifestPath}`
            : `owned manifest present at ${manifestPath}`,
      })
    }
  }
  const sessionIssue = selectedSessionIssue(options.sessionId)
  const sessionSelected = options.sessionId !== null
  findings.push({
    check: 'session',
    ok: sessionIssue === null && sessionSelected && !sessionMismatch,
    detail:
      sessionIssue !== null
        ? sessionIssue
        : !sessionSelected
          ? 'no usable selected Session; covered Bash calls fail closed (blocked, exit 2) until a Session is selected'
          : sessionMismatch
            ? `installed adapter routes through Session ${installedSessionId ?? '(none)'}, not the selected ${options.sessionId}; run remove then setup to change Sessions`
            : `selected Session ${options.sessionId}; covered Bash calls route through ocbox exec`,
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
    if (manifestRaw !== null && options.files.removePath !== undefined) {
      await options.files.removePath(manifestPath).catch(() => undefined)
    }
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
  // A fresh install created the whole settings file; when removing leaves it
  // empty, delete the adapter-created file instead of leaving `{}`. A target
  // that existed before setup (createdFile false) is always rewritten so its
  // original bytes survive.
  const deleteCreatedFile =
    manifest?.createdFile === true &&
    conflicts.length === 0 &&
    Object.keys(removed.document).length === 0
  try {
    if (deleteCreatedFile && options.files.removePath !== undefined) {
      await options.files.removePath(targetPath)
    } else {
      await options.files.writeText(targetPath, stableStringify(removed.document))
    }
    if (conflicts.length === 0 && manifestRaw !== null && options.files.removePath !== undefined) {
      await options.files.removePath(manifestPath).catch(() => undefined)
    }
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
    removePath: removePathIfPresent,
  }
}

import { lstat, realpath } from 'node:fs/promises'
import { SessionIdSchema } from '../../contracts.js'
import { CAPABILITY_MATRIX, ROUTING_AID_NOTICE } from './capabilities.js'
import { planMerge, planRemove as planRemoveEntries, sha256Json } from './merge.js'
import { assertSettingsPathWithinRoot, ClaudeSettingsPathBoundaryError } from './path-boundary.js'
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
  /**
   * Optional link-resolving realpath. When provided (the live CLI always does),
   * every plan operation refuses a settings target whose existing parents or
   * target escape the expected project/user settings root through a directory
   * junction, symlink, or Windows reparse point.
   */
  readonly realpath?: (path: string) => Promise<string>
  /**
   * Optional `lstat` companion to `realpath`. When present it lets the boundary
   * check recognize a dangling symlink/junction/reparse point (which `realpath`
   * reports as absent) and refuse it with the typed boundary error instead of
   * surfacing a raw ENOENT during the write.
   */
  readonly lstat?: (path: string) => Promise<{ readonly isSymbolicLink: () => boolean }>
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

function sessionIssueMessage(sessionId: string): string {
  return `Selected Session "${sessionId}" is not a valid Session ID (expected a UUID or ULID); run "ocbox session list" and re-run with a real --session value`
}

/**
 * Canonicalize a supplied Session ID exactly once. `SessionIdSchema` trims and
 * validates, so shell-padded values collapse to the canonical form that is then
 * embedded in the owned hook command, recorded in the manifest, and compared by
 * doctor and rotation. Refusing to canonicalize means a padded id could be
 * installed raw, producing a hook the anchored parser cannot detect or remove.
 */
export function canonicalSessionId(sessionId: string | null): string | null {
  if (sessionId === null) return null
  try {
    return SessionIdSchema.parse(sessionId)
  } catch {
    throw new Error(sessionIssueMessage(sessionId))
  }
}

/**
 * Doctor cannot throw on an invalid id because it must report findings, but it
 * still canonicalizes through the same schema so its healthy/unhealthy verdict
 * matches setup exactly.
 */
interface CanonicalSession {
  readonly sessionId: string | null
  readonly issue: string | null
}

function canonicalSessionIdSafely(sessionId: string | null): CanonicalSession {
  try {
    return { sessionId: canonicalSessionId(sessionId), issue: null }
  } catch (error) {
    return { sessionId: null, issue: errorMessage(error) }
  }
}

interface ReconstructedOwnership {
  readonly baseDocument: ClaudeSettingsDocument
  readonly createdPointers: readonly string[]
  readonly createdFile: boolean
}

/**
 * Best-effort reconstruction of the pre-ownership document and the manifest
 * metadata derivable from *exact* owned shapes when the manifest is absent.
 * Only the anchored owned hook command and the exact owned permission rule are
 * removed, and only containers those removals emptied are pruned, so co-located
 * user hooks/rules survive. The true original bytes and whether the adapter
 * created the file cannot be recovered; `docs/claude-code-adapter.md` records
 * these limits.
 */
function reconstructOwnedBase(document: ClaudeSettingsDocument): ReconstructedOwnership {
  const removal = planRemoveEntries(document, [], { pruneEmptiedOwned: true })
  return {
    baseDocument: removal.document,
    createdPointers: removal.prunedPointers,
    createdFile: Object.keys(removal.document).length === 0,
  }
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

async function assertTargetBoundary(files: PlannerFileAccess, targetPath: string): Promise<void> {
  if (files.realpath === undefined) return
  await assertSettingsPathWithinRoot(targetPath, files.realpath, files.lstat)
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : null
}

/**
 * Backstop for a symlink/junction/reparse point that the portable `lstat` check
 * cannot recognize (for example a non-junction Windows reparse point). A
 * residual ENOENT/ENOTDIR/ELOOP while writing the settings target is a path
 * resolution failure, not a generic IO error, so surface the typed boundary
 * refusal instead of a raw filesystem error.
 */
function wrapTargetWriteError(targetPath: string, error: unknown): unknown {
  const code = errorCode(error)
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
    return new ClaudeSettingsPathBoundaryError(
      `Refusing to write "${targetPath}": the settings path could not be resolved (${code}), which indicates a dangling or unsupported symlink, junction, or reparse point.`,
    )
  }
  return error
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

interface PolicySourceIssue {
  readonly kind: ClaudeSettingsSource
  readonly path: string
  readonly message: string
  readonly atOrAboveTarget: boolean
}

interface PolicyEvaluation {
  readonly locks: readonly PolicyLock[]
  readonly shadowing: readonly PolicyShadow[]
  readonly deny: readonly string[]
  readonly ask: readonly string[]
  readonly issues: readonly PolicySourceIssue[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error)
}

function describePolicyIssue(issue: PolicySourceIssue): string {
  const rank = issue.atOrAboveTarget ? 'at or above target' : 'below target'
  return `${issue.kind} (${issue.path}, ${rank}): ${issue.message}`
}

// Read-only evaluation of every applicable settings source. Claude Code unions
// deny/ask rules across all settings sources and evaluates them deny-first, so a
// rule from a source ranked below the target still shadows the owned allow; the
// PreToolUse hook fires before permission evaluation, so the command would route
// remotely before the local deny/ask applied. Locks are a different concept: they
// are a managed-policy gate, so they are honored only from sources at or above
// the target. Write precedence governs which source the adapter may write, not
// whether a rule blocks.
//
// A source that cannot be read or parsed is also a policy risk: its deny/ask may
// be unknown, so setup fails closed instead of unioning an incomplete policy.
// The distinction at/above vs below the target is preserved in the report so the
// operator can see which layer must be repaired.
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
  const issues: PolicySourceIssue[] = []
  for (const source of sources) {
    let raw: string | null
    try {
      raw = await files.readText(source.path)
    } catch (error) {
      issues.push({
        kind: source.kind,
        path: source.path,
        atOrAboveTarget: source.precedence <= targetRank,
        message: `unreadable: ${errorMessage(error)}`,
      })
      continue
    }
    if (raw === null) continue
    const parsed = parseSettingsJson(source.path, raw)
    if (parsed.issues.length > 0) {
      issues.push({
        kind: source.kind,
        path: source.path,
        atOrAboveTarget: source.precedence <= targetRank,
        message: parsed.issues.map((issue) => issue.message).join('; '),
      })
      continue
    }
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
  return { locks, shadowing, deny, ask, issues }
}

function policySourceError(issues: readonly PolicySourceIssue[]): Error {
  return new Error(
    `Settings policy sources could not be read or validated; setup fails closed before writing (${issues
      .map(describePolicyIssue)
      .join('; ')}). Fix or remove the invalid source, then re-run setup.`,
  )
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
  const sessionId = canonicalSessionId(options.sessionId)
  const targetPath = targetPathForScope(options.layout, options.scope)
  await assertTargetBoundary(options.files, targetPath)
  const current = await loadDocument(options.files, targetPath)
  if (current.issues.length > 0) {
    throw new Error(`Target settings failed validation: ${current.issues.join('; ')}`)
  }
  const policy = await evaluatePolicy(options.files, options.layout, options.scope)
  if (policy.issues.length > 0) throw policySourceError(policy.issues)
  if (policy.locks.length > 0) throw managedLockError(policy.locks)
  if (policy.shadowing.length > 0) throw shadowedRouterError(policy.shadowing)
  const manifestPath = manifestPathForTarget(targetPath)
  const existingManifest = parseManifestContent(await options.files.readText(manifestPath))
  const merged = planMerge(current.document, sessionId, {
    higherDeny: policy.deny,
    higherAsk: policy.ask,
  })
  if (merged.protectedRules.length > 0) throw protectedRulesError(merged.protectedRules)
  const alreadyOwned = merged.ownedHookPresent || merged.ownedPermissionPresent
  if (merged.alreadyApplied) {
    if (existingManifest !== null) {
      return {
        status: 'already-applied',
        targetPath,
        backupPath: null,
        manifestPath,
        sessionId,
        pinnedVersion: PINNED_CLAUDE_CODE_VERSION,
        protectedRules: merged.protectedRules,
      }
    }
    // Owned entries are already applied but the manifest was lost (hard crash
    // between the target write and the manifest write, or manual deletion).
    // Rebuild a truthful manifest from exact owned shapes only. The target is
    // untouched and no backup is written because the original bytes are unknown;
    // `backupPath: null` makes `remove` refuse byte-for-byte restoration.
    const healedAt = options.files.now?.() ?? new Date()
    const reconstructed = reconstructOwnedBase(current.document)
    const healedManifest: OwnedManifest = {
      adapter: 'claude-code',
      pinnedVersion: PINNED_CLAUDE_CODE_VERSION,
      targetPath,
      baseHash: sha256Json(reconstructed.baseDocument),
      appliedHash: hashDocument(current.document),
      desiredHash: hashDocument(current.document),
      sessionId,
      updatedAt: healedAt.toISOString(),
      backupPath: null,
      createdPointers: reconstructed.createdPointers,
      protectedRules: merged.protectedRules,
      createdFile: reconstructed.createdFile,
    }
    await options.files.writeText(manifestPath, `${JSON.stringify(healedManifest, null, 2)}\n`)
    return {
      status: 'already-applied',
      targetPath,
      backupPath: null,
      manifestPath,
      sessionId,
      pinnedVersion: PINNED_CLAUDE_CODE_VERSION,
      protectedRules: merged.protectedRules,
    }
  }
  const now = options.files.now?.() ?? new Date()
  const currentBaseHash = sha256Json(current.document)
  // The owned backup captures the *original* pre-ownership bytes. Re-setup (for
  // example a Session rotation) must never overwrite it with the already-owned
  // document, otherwise `remove` would restore the owned hook instead of the
  // user's file. Only record a backup when the current bytes are proven to be
  // the base snapshot, and reuse an existing backup when it is still present.
  let backupPath: string | null = existingManifest?.backupPath ?? null
  if (backupPath !== null && (await options.files.readText(backupPath)) === null) {
    backupPath = null
  }
  let baseHash: string
  let carriedPointers: readonly string[]
  let createdFile: boolean
  if (existingManifest !== null) {
    baseHash = existingManifest.baseHash
    carriedPointers = existingManifest.createdPointers
    createdFile = existingManifest.createdFile
  } else if (alreadyOwned) {
    // Manifest lost while a rotation or a partial owned state is being applied:
    // reconstruct the base from exact owned shapes so the already-owned document
    // is never recorded as the base or captured as the original backup.
    const reconstructed = reconstructOwnedBase(current.document)
    baseHash = sha256Json(reconstructed.baseDocument)
    carriedPointers = reconstructed.createdPointers
    createdFile = reconstructed.createdFile
    backupPath = null
  } else {
    baseHash = currentBaseHash
    carriedPointers = []
    createdFile = current.raw === null
  }
  if (
    backupPath === null &&
    current.raw !== null &&
    (existingManifest === null ? !alreadyOwned : existingManifest.baseHash === currentBaseHash)
  ) {
    backupPath = backupPathForTarget(targetPath, now)
    await options.files.writeText(backupPath, current.raw)
  }
  const nextManifest: OwnedManifest = {
    adapter: 'claude-code',
    pinnedVersion: PINNED_CLAUDE_CODE_VERSION,
    targetPath,
    baseHash,
    appliedHash: hashDocument(merged.document),
    desiredHash: hashDocument(merged.document),
    sessionId,
    updatedAt: now.toISOString(),
    backupPath,
    createdPointers: [...new Set([...carriedPointers, ...merged.createdPointers])],
    protectedRules: merged.protectedRules,
    createdFile,
  }
  try {
    await options.files.writeText(targetPath, stableStringify(merged.document))
  } catch (error) {
    await rollbackTarget(options.files, targetPath, current.raw)
    throw wrapTargetWriteError(targetPath, error)
  }
  try {
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
    sessionId,
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
  await assertTargetBoundary(options.files, targetPath)
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
    let raw: string | null
    try {
      raw = await options.files.readText(entry.path)
    } catch (error) {
      corrupt = true
      findings.push({
        check: `settings-${entry.source}`,
        ok: false,
        detail: `${entry.source} unreadable at ${entry.path}: ${errorMessage(error)}`,
      })
      continue
    }
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
  findings.push({
    check: 'policy-sources',
    ok: policy.issues.length === 0,
    detail:
      policy.issues.length === 0
        ? 'all policy-bearing settings sources are readable and schema-valid'
        : `setup fails closed because a policy-bearing settings source cannot be read or validated: ${policy.issues
            .map(describePolicyIssue)
            .join('; ')}`,
  })
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
  const canonical = canonicalSessionIdSafely(options.sessionId)
  const sessionId = canonical.sessionId
  const current = await loadDocument(options.files, targetPath)
  if (current.issues.length > 0) {
    findings.push({
      check: 'owned-entries',
      ok: false,
      detail: `target invalid: ${current.issues.join('; ')}`,
    })
  } else {
    const merged = planMerge(current.document, sessionId)
    installedSessionId = merged.installedSessionId
    sessionMismatch = merged.ownedHookPresent && merged.installedSessionId !== sessionId
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
  const sessionIssue = canonical.issue
  const sessionSelected = sessionId !== null
  findings.push({
    check: 'session',
    ok: sessionIssue === null && sessionSelected && !sessionMismatch,
    detail:
      sessionIssue !== null
        ? sessionIssue
        : !sessionSelected
          ? 'no usable selected Session; covered Bash calls fail closed (blocked, exit 2) until a Session is selected'
          : sessionMismatch
            ? `installed adapter routes through Session ${installedSessionId ?? '(none)'}, not the selected ${sessionId}; run remove then setup to change Sessions`
            : `selected Session ${sessionId}; covered Bash calls route through ocbox exec`,
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
  await assertTargetBoundary(options.files, targetPath)
  const current = await loadDocument(options.files, targetPath)
  if (current.issues.length > 0) {
    // A target that fails schema validation can still contain a container the
    // adapter once owned and a user later replaced with a different type.
    // Surface those container-invalid conflicts and retain the ownership
    // manifest so the operator keeps repair context instead of getting a
    // misleadingly clean `not-installed`. `planRemoveEntries` is pure and only
    // reads the parsed document, so running it on a schema-invalid document is
    // safe.
    const conflicts = planRemoveEntries(current.document, [], {
      pruneEmptiedOwned: false,
    }).conflicts.map((conflict) => conflict.pointer)
    return {
      status: 'not-installed',
      targetPath,
      repairPlan: [
        `target ${targetPath} is invalid: ${current.issues.join('; ')}`,
        'restore the newest .ocbox-backup-*.json by hand, then re-run doctor; owned entries were not touched',
        ...(conflicts.length > 0
          ? [
              `container-invalid at ${conflicts.join(', ')}: user replaced an owned container with a different type; left untouched for manual review`,
              `ownership manifest retained at ${manifestPathForTarget(targetPath)} for repair context`,
            ]
          : []),
      ],
      conflicts,
    }
  }
  const manifestPath = manifestPathForTarget(targetPath)
  const manifestRaw = await options.files.readText(manifestPath)
  const manifest = parseManifestContent(manifestRaw)
  // With a manifest, prune exactly the containers it recorded as created. With
  // the manifest lost, fall back to pruning containers that exact-owned removal
  // emptied; nothing else is touched, so co-located user content survives.
  const removed = planRemoveEntries(current.document, manifest?.createdPointers ?? [], {
    pruneEmptiedOwned: manifest === null,
  })
  const conflicts = removed.conflicts.map((conflict) => conflict.pointer)
  if (removed.removedHooks === 0 && removed.removedPermissions === 0 && !removed.changed) {
    if (conflicts.length > 0) {
      // A user replaced an owned container with a different type, so nothing
      // exact-owned could be removed. Retain the manifest and surface the
      // conflict instead of reporting a clean `not-installed`.
      return {
        status: 'not-installed',
        targetPath,
        repairPlan: [
          `container-invalid at ${conflicts.join(', ')}: user replaced an owned container with a different type; left untouched for manual review`,
          `ownership manifest retained at ${manifestPath} for repair context`,
        ],
        conflicts,
      }
    }
    if (manifestRaw !== null && options.files.removePath !== undefined) {
      await options.files.removePath(manifestPath).catch(() => undefined)
    }
    return { status: 'not-installed', targetPath, repairPlan: [], conflicts: [] }
  }
  // Byte-for-byte restoration: only for a pre-existing file that the manifest
  // proves was owned by this adapter, that has no conflicting user edits, and
  // whose current content prunes back to the recorded base snapshot. The
  // recorded backup must itself hash to that same base snapshot, so a missing,
  // replaced, or stale backup is never trusted. Any drift falls through to the
  // non-destructive textual prune below, preserving the user's edits.
  let restoredRaw: string | null = null
  if (
    manifest !== null &&
    manifest.createdFile === false &&
    conflicts.length === 0 &&
    manifest.backupPath !== null &&
    manifest.appliedHash === hashDocument(current.document) &&
    sha256Json(removed.document) === manifest.baseHash
  ) {
    const candidate = await options.files.readText(manifest.backupPath)
    if (candidate !== null) {
      const parsedBackup = parseSettingsJson(manifest.backupPath, candidate)
      if (
        parsedBackup.issues.length === 0 &&
        sha256Json(parsedBackup.document) === manifest.baseHash
      ) {
        restoredRaw = candidate
      }
    }
  }
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
  // that existed before setup (createdFile false) is restored from the owned
  // backup byte-for-byte when that is safe; otherwise it is rewritten from the
  // pruned document so the original bytes still survive semantically. When the
  // manifest is lost, an empty result can only have been produced by owned
  // removals, so the owned-only file is deleted too (the reconstruction limit
  // below cannot distinguish this from a pre-existing empty file).
  const becameEmpty = Object.keys(removed.document).length === 0
  const removedOwnedEntries = removed.removedHooks > 0 || removed.removedPermissions > 0
  const deleteCreatedFile =
    conflicts.length === 0 &&
    becameEmpty &&
    (manifest?.createdFile === true || (manifest === null && removedOwnedEntries))
  try {
    if (deleteCreatedFile && options.files.removePath !== undefined) {
      await options.files.removePath(targetPath)
    } else if (restoredRaw !== null) {
      await options.files.writeText(targetPath, restoredRaw)
    } else {
      await options.files.writeText(targetPath, stableStringify(removed.document))
    }
    if (conflicts.length === 0 && manifestRaw !== null && options.files.removePath !== undefined) {
      await options.files.removePath(manifestPath).catch(() => undefined)
    }
  } catch (error) {
    await rollbackTarget(options.files, targetPath, current.raw)
    throw wrapTargetWriteError(targetPath, error)
  }
  return { status: 'removed', targetPath, repairPlan, conflicts }
}

export function liveFileAccess(): PlannerFileAccess {
  return {
    readText: readTextIfPresent,
    writeText: writeFileAtomic,
    removePath: removePathIfPresent,
    realpath,
    lstat,
  }
}

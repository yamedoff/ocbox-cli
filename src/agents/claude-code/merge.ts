import { createHash } from 'node:crypto'
import { getAtPointer, hashJson, stableStringify } from './json.js'
import { buildHookCommand, parseOwnedHookCommand } from './routing.js'
import { CLAUDE_CODE_HOOK_TIMEOUT_SECONDS } from './timeouts.js'
import {
  type ClaudeHookRecord,
  type ClaudeSettingsDocument,
  type MutableClaudePermissions,
  type MutableClaudeSettings,
  type MutableHookEvents,
  COVERED_HOOK_EVENT,
  COVERED_HOOK_MATCHER,
  hookEntryOwned,
  hookObjectOwned,
  OWNED_PERMISSION_ALLOW,
  permissionRuleOwned,
  shadowingPermissionRules,
} from './settings-model.js'

export interface MergePlan {
  readonly alreadyApplied: boolean
  readonly addedHook: boolean
  readonly addedPermission: boolean
  readonly document: ClaudeSettingsDocument
  readonly additions: readonly string[]
  readonly createdPointers: readonly string[]
  readonly preservedDeny: readonly string[]
  readonly preservedAsk: readonly string[]
  readonly protectedRules: readonly string[]
  readonly readOnlySource: boolean
  readonly changed: boolean
  readonly ownedHookPresent: boolean
  readonly ownedPermissionPresent: boolean
  readonly installedSessionId: string | null
  readonly sessionChanged: boolean
  /**
   * True when an already-owned hook was missing the explicit F7 hook `timeout`
   * (or carried a different one) and was reconciled to the current contract.
   * Treated as a change so re-running setup heals an install made before F7.
   */
  readonly reconciledHookTimeout: boolean
}

export interface PlanMergeOptions {
  readonly higherDeny?: readonly string[]
  readonly higherAsk?: readonly string[]
  readonly readOnlySource?: boolean
}

export function sha256Json(value: unknown): string {
  return createHash('sha256')
    .update(stableStringify(value as never))
    .digest('hex')
}

export function hashOwnedValue(value: unknown): string {
  return hashJson(value as never)
}

function cloneDocument(document: ClaudeSettingsDocument): MutableClaudeSettings {
  return JSON.parse(JSON.stringify(document)) as MutableClaudeSettings
}

function ensureStringArray(container: MutableClaudePermissions, key: 'allow'): string[] {
  const existing = container[key]
  if (Array.isArray(existing)) {
    const copy = [...existing]
    container[key] = copy
    return copy as string[]
  }
  const created: string[] = []
  container[key] = created
  return created
}

function asMutableSettings<Shape extends object>(value: unknown): Shape | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Shape
}

function stringRules(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function hookCommand(hook: unknown): unknown {
  if (hook === null || typeof hook !== 'object' || Array.isArray(hook)) return undefined
  return (hook as ClaudeHookRecord).command
}

export function ownedEntriesStatus(document: ClaudeSettingsDocument): {
  readonly hook: boolean
  readonly permission: boolean
} {
  const hooksContainer = asMutableSettings<MutableHookEvents>(document.hooks)
  const entries = hooksContainer?.[COVERED_HOOK_EVENT]
  const hook = Array.isArray(entries) && entries.some(hookEntryOwned)
  const permissionsContainer = asMutableSettings<MutableClaudePermissions>(document.permissions)
  const allow = permissionsContainer?.allow
  const permission = Array.isArray(allow) && allow.some(permissionRuleOwned)
  return { hook, permission }
}

function installedOwnedSessionId(document: ClaudeSettingsDocument): string | null {
  const hooksContainer = asMutableSettings<MutableHookEvents>(document.hooks)
  const entries = hooksContainer?.[COVERED_HOOK_EVENT]
  if (!Array.isArray(entries)) return null
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const hooks = (entry as ClaudeHookRecord).hooks
    if (!Array.isArray(hooks)) continue
    for (const hook of hooks) {
      const parsed = parseOwnedHookCommand(hookCommand(hook))
      if (parsed !== null) return parsed.sessionId
    }
  }
  return null
}

export function planMerge(
  document: ClaudeSettingsDocument,
  sessionId: string | null,
  options: PlanMergeOptions = {},
): MergePlan {
  const next = cloneDocument(document)
  const additions: string[] = []
  const createdPointers: string[] = []
  const protectedRules: string[] = []
  const readOnlySource = options.readOnlySource === true
  const ownedStatus = ownedEntriesStatus(document)
  const installedSessionId = installedOwnedSessionId(document)

  const permissionsBefore = asMutableSettings<MutableClaudePermissions>(
    (document as Record<string, unknown>)['permissions'],
  )
  const preservedDeny = stringRules(permissionsBefore?.deny)
  const preservedAsk = stringRules(permissionsBefore?.ask)

  const higherDeny = options.higherDeny ?? []
  const higherAsk = options.higherAsk ?? []

  let addedHook = false
  let addedPermission = false
  let sessionChanged = false
  let reconciledHookTimeout = false

  if (!readOnlySource) {
    const hadHooks = next.hooks !== undefined
    const hooksContainer: MutableHookEvents = asMutableSettings<MutableHookEvents>(next.hooks) ?? {}
    next.hooks = hooksContainer

    const hadEvent = hooksContainer[COVERED_HOOK_EVENT] !== undefined
    const existing = hooksContainer[COVERED_HOOK_EVENT]
    if (existing !== undefined && !Array.isArray(existing)) {
      protectedRules.push('/hooks/PreToolUse')
    } else {
      const entries: unknown[] = Array.isArray(existing) ? existing : []
      hooksContainer[COVERED_HOOK_EVENT] = entries
      if (ownedStatus.hook) {
        // Same Session means idempotent; a different Session is rotated in
        // place so commands never silently keep routing to an old Session.
        for (const entry of entries) {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
          const record = entry as ClaudeHookRecord
          if (!Array.isArray(record.hooks)) continue
          for (const hook of record.hooks) {
            const parsed = parseOwnedHookCommand(hookCommand(hook))
            if (parsed === null) continue
            if (parsed.sessionId !== sessionId) {
              ;(hook as { command?: unknown }).command = buildHookCommand(sessionId)
              sessionChanged = true
            }
            // Reconcile the explicit F7 hook timeout on pre-existing owned
            // hooks so an install made before the timeout contract heals on the
            // next setup instead of staying fail-open at the implicit default.
            if ((hook as { timeout?: unknown }).timeout !== CLAUDE_CODE_HOOK_TIMEOUT_SECONDS) {
              ;(hook as { timeout?: unknown }).timeout = CLAUDE_CODE_HOOK_TIMEOUT_SECONDS
              reconciledHookTimeout = true
            }
          }
        }
      } else {
        entries.push({
          matcher: COVERED_HOOK_MATCHER,
          hooks: [
            {
              type: 'command',
              command: buildHookCommand(sessionId),
              timeout: CLAUDE_CODE_HOOK_TIMEOUT_SECONDS,
            },
          ],
        })
        addedHook = true
        additions.push('/hooks/PreToolUse')
      }
      if (addedHook && !hadEvent) createdPointers.push('/hooks/PreToolUse')
      if (addedHook && !hadHooks) createdPointers.push('/hooks')
    }

    const hadPermissions = next.permissions !== undefined
    const permissionsContainer: MutableClaudePermissions =
      asMutableSettings<MutableClaudePermissions>(next.permissions) ?? {}
    next.permissions = permissionsContainer

    const hadAllow = permissionsContainer.allow !== undefined
    if (permissionsContainer.allow !== undefined && !Array.isArray(permissionsContainer.allow)) {
      protectedRules.push('/permissions/allow')
    } else {
      const allow = ensureStringArray(permissionsContainer, 'allow')
      const shadowing = shadowingPermissionRules([
        ...higherDeny,
        ...higherAsk,
        ...preservedDeny,
        ...preservedAsk,
      ])
      if (shadowing.length > 0) {
        for (const rule of shadowing) {
          if (!protectedRules.includes(rule)) protectedRules.push(rule)
        }
      } else if (!allow.some(permissionRuleOwned)) {
        allow.push(OWNED_PERMISSION_ALLOW)
        addedPermission = true
        additions.push('/permissions/allow')
      }
      if (addedPermission && !hadAllow) createdPointers.push('/permissions/allow')
      if (addedPermission && !hadPermissions) createdPointers.push('/permissions')
    }
    // `deny`/`ask` are never synthesized: the adapter does not read them, and
    // fabricating empty arrays breaks exact restoration on `remove`.
  } else {
    protectedRules.push(OWNED_PERMISSION_ALLOW, '/hooks/PreToolUse')
  }

  const changed = addedHook || addedPermission || sessionChanged || reconciledHookTimeout
  return {
    alreadyApplied: !changed,
    addedHook,
    addedPermission,
    document: next,
    additions,
    createdPointers: changed ? createdPointers : [],
    preservedDeny,
    preservedAsk,
    protectedRules,
    readOnlySource,
    changed,
    ownedHookPresent: ownedStatus.hook,
    ownedPermissionPresent: ownedStatus.permission,
    installedSessionId,
    sessionChanged,
    reconciledHookTimeout,
  }
}

export interface RemovePlan {
  readonly removedHooks: number
  readonly removedPermissions: number
  readonly document: ClaudeSettingsDocument
  readonly affected: readonly string[]
  readonly conflicts: readonly { readonly pointer: string; readonly reason: 'container-invalid' }[]
  /**
   * Containers that held only exact-owned entries and became empty once those
   * entries were removed (for example `/hooks/PreToolUse` and its `/hooks`
   * parent). Unlike `createdPointers`, this is derived purely from the exact
   * owned shapes present, so it can drive pruning when the manifest is lost.
   */
  readonly emptiedOwnedContainers: readonly string[]
  /** Pointers actually deleted from the document by pruning (empty only). */
  readonly prunedPointers: readonly string[]
  readonly changed: boolean
}

export interface RemoveOptions {
  /**
   * Also prune containers emptied solely by removing owned entries, without a
   * manifest's `createdPointers`. Used when the manifest is missing so an
   * adapter-owned-only document can collapse back to `{}` (or be deleted).
   */
  readonly pruneEmptiedOwned?: boolean
}

function pruneEmptyCreatedPointers(
  document: ClaudeSettingsDocument,
  createdPointers: readonly string[],
): { readonly document: ClaudeSettingsDocument; readonly removed: readonly string[] } {
  const next = cloneDocument(document) as unknown as Record<string, unknown>
  const removed: string[] = []
  const ordered = [...createdPointers].sort((left, right) => right.length - left.length)
  for (const pointer of ordered) {
    const value = getAtPointer(next as never, pointer)
    if (value === undefined) continue
    const empty =
      (Array.isArray(value) && value.length === 0) ||
      (value !== null && typeof value === 'object' && Object.keys(value).length === 0)
    if (!empty) continue
    const segments = pointer
      .slice(1)
      .split('/')
      .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    let cursor: unknown = next
    let ok = true
    for (let index = 0; index < segments.length - 1; index += 1) {
      if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
        ok = false
        break
      }
      cursor = (cursor as Record<string, unknown>)[segments[index] as string]
    }
    const leaf = segments[segments.length - 1] as string
    if (ok && cursor !== null && typeof cursor === 'object' && !Array.isArray(cursor)) {
      delete (cursor as Record<string, unknown>)[leaf]
      removed.push(pointer)
    }
  }
  return { document: next as unknown as ClaudeSettingsDocument, removed }
}

export function planRemove(
  document: ClaudeSettingsDocument,
  createdPointers: readonly string[] = [],
  options: RemoveOptions = {},
): RemovePlan {
  const next = cloneDocument(document)
  let removedHooks = 0
  let removedPermissions = 0
  const affected: string[] = []
  const conflicts: { pointer: string; reason: 'container-invalid' }[] = []
  const emptiedOwnedContainers: string[] = []
  const hooksContainer = asMutableSettings<MutableHookEvents>(next.hooks)
  if (hooksContainer !== null) {
    const entries = hooksContainer[COVERED_HOOK_EVENT]
    if (entries !== undefined && !Array.isArray(entries)) {
      conflicts.push({ pointer: '/hooks/PreToolUse', reason: 'container-invalid' })
    } else if (Array.isArray(entries)) {
      const keptEntries: unknown[] = []
      let hooksChanged = false
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          keptEntries.push(entry)
          continue
        }
        const hooks = (entry as ClaudeHookRecord).hooks
        if (!Array.isArray(hooks)) {
          keptEntries.push(entry)
          continue
        }
        const keptHooks = hooks.filter((hook) => {
          if (hookObjectOwned(hook)) {
            removedHooks += 1
            return false
          }
          return true
        })
        if (keptHooks.length === hooks.length) {
          keptEntries.push(entry)
          continue
        }
        hooksChanged = true
        if (keptHooks.length > 0) {
          keptEntries.push({ ...(entry as Record<string, unknown>), hooks: keptHooks })
        }
      }
      if (hooksChanged) {
        hooksContainer[COVERED_HOOK_EVENT] = keptEntries
        affected.push('/hooks/PreToolUse')
        // Every entry in the event was exact-owned, so the event array and its
        // `/hooks` parent became empty solely through owned removal. The parent
        // pointer is only deleted if it is also empty after pruning.
        if (keptEntries.length === 0) {
          emptiedOwnedContainers.push('/hooks/PreToolUse', '/hooks')
        }
      }
    }
  }
  const permissionsContainer = asMutableSettings<MutableClaudePermissions>(next.permissions)
  if (permissionsContainer !== null) {
    const allow = permissionsContainer.allow
    if (allow !== undefined && !Array.isArray(allow)) {
      conflicts.push({ pointer: '/permissions/allow', reason: 'container-invalid' })
    } else if (Array.isArray(allow)) {
      const kept = allow.filter((rule) => {
        if (permissionRuleOwned(rule)) {
          removedPermissions += 1
          return false
        }
        return true
      })
      if (kept.length !== allow.length) {
        permissionsContainer.allow = kept
        affected.push('/permissions/allow')
        if (kept.length === 0) {
          emptiedOwnedContainers.push('/permissions/allow', '/permissions')
        }
      }
    }
  }
  const pointers =
    options.pruneEmptiedOwned === true
      ? [...createdPointers, ...emptiedOwnedContainers]
      : createdPointers
  const pruned = pruneEmptyCreatedPointers(next, pointers)
  return {
    removedHooks,
    removedPermissions,
    document: pruned.document,
    affected: [...affected, ...pruned.removed],
    conflicts,
    emptiedOwnedContainers,
    prunedPointers: pruned.removed,
    changed: removedHooks > 0 || removedPermissions > 0 || pruned.removed.length > 0,
  }
}

import { createHash } from 'node:crypto'
import { getAtPointer, hashJson, stableStringify } from './json.js'
import { buildHookCommand } from './routing.js'
import {
  type ClaudeSettingsDocument,
  type MutableClaudePermissions,
  type MutableClaudeSettings,
  type MutableHookEvents,
  COVERED_HOOK_EVENT,
  COVERED_HOOK_MATCHER,
  hookEntryOwned,
  OWNED_PERMISSION_ALLOW,
  permissionRuleOwned,
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

  const permissionsBefore = asMutableSettings<MutableClaudePermissions>(
    (document as Record<string, unknown>)['permissions'],
  )
  const preservedDeny = stringRules(permissionsBefore?.deny)
  const preservedAsk = stringRules(permissionsBefore?.ask)

  const higherDeny = new Set(options.higherDeny ?? [])
  const higherAsk = new Set(options.higherAsk ?? [])
  const localDeny = new Set(preservedDeny)
  const localAsk = new Set(preservedAsk)

  let addedHook = false
  let addedPermission = false

  if (!readOnlySource) {
    const hadHooks = next.hooks !== undefined
    const hooksContainer: MutableHookEvents = asMutableSettings<MutableHookEvents>(next.hooks) ?? {}
    next.hooks = hooksContainer

    const hadEvent = hooksContainer[COVERED_HOOK_EVENT] !== undefined
    const existing = hooksContainer[COVERED_HOOK_EVENT]
    if (existing !== undefined && !Array.isArray(existing)) {
      protectedRules.push('/hooks/PreToolUse')
    } else {
      const entries: unknown[] = Array.isArray(existing) ? [...existing] : []
      hooksContainer[COVERED_HOOK_EVENT] = entries
      if (!entries.some(hookEntryOwned)) {
        entries.push({
          matcher: COVERED_HOOK_MATCHER,
          hooks: [{ type: 'command', command: buildHookCommand(sessionId) }],
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
      const shadowed =
        higherDeny.has(OWNED_PERMISSION_ALLOW) ||
        higherAsk.has(OWNED_PERMISSION_ALLOW) ||
        localDeny.has(OWNED_PERMISSION_ALLOW) ||
        localAsk.has(OWNED_PERMISSION_ALLOW)
      if (shadowed) {
        protectedRules.push(OWNED_PERMISSION_ALLOW)
      } else if (!allow.some(permissionRuleOwned)) {
        allow.push(OWNED_PERMISSION_ALLOW)
        addedPermission = true
        additions.push('/permissions/allow')
      }
      if (addedPermission && !hadAllow) createdPointers.push('/permissions/allow')
      if (addedPermission && !hadPermissions) createdPointers.push('/permissions')
    }
    if (permissionsContainer.deny === undefined) permissionsContainer.deny = []
    if (permissionsContainer.ask === undefined) permissionsContainer.ask = []
  } else {
    protectedRules.push(OWNED_PERMISSION_ALLOW, '/hooks/PreToolUse')
  }

  const changed = addedHook || addedPermission
  return {
    alreadyApplied: !addedHook && !addedPermission,
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
  }
}

export interface RemovePlan {
  readonly removedHooks: number
  readonly removedPermissions: number
  readonly document: ClaudeSettingsDocument
  readonly affected: readonly string[]
  readonly conflicts: readonly { readonly pointer: string; readonly reason: 'container-invalid' }[]
  readonly changed: boolean
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
): RemovePlan {
  const next = cloneDocument(document)
  let removedHooks = 0
  let removedPermissions = 0
  const affected: string[] = []
  const conflicts: { pointer: string; reason: 'container-invalid' }[] = []
  const hooksContainer = asMutableSettings<MutableHookEvents>(next.hooks)
  if (hooksContainer !== null) {
    const entries = hooksContainer[COVERED_HOOK_EVENT]
    if (entries !== undefined && !Array.isArray(entries)) {
      conflicts.push({ pointer: '/hooks/PreToolUse', reason: 'container-invalid' })
    } else if (Array.isArray(entries)) {
      const kept = entries.filter((entry) => {
        if (hookEntryOwned(entry)) {
          removedHooks += 1
          return false
        }
        return true
      })
      if (kept.length !== entries.length) {
        hooksContainer[COVERED_HOOK_EVENT] = kept
        affected.push('/hooks/PreToolUse')
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
      }
    }
  }
  const pruned = pruneEmptyCreatedPointers(next, createdPointers)
  return {
    removedHooks,
    removedPermissions,
    document: pruned.document,
    affected: [...affected, ...pruned.removed],
    conflicts,
    changed: removedHooks > 0 || removedPermissions > 0 || pruned.removed.length > 0,
  }
}

export interface DriftReport {
  readonly drifted: boolean
  readonly details: readonly string[]
}

export function detectDrift(
  baseDocument: ClaudeSettingsDocument,
  currentDocument: ClaudeSettingsDocument,
): DriftReport {
  const details: string[] = []
  const hooksContainer = asMutableSettings<MutableHookEvents>(
    currentDocument.hooks,
  ) as MutableHookEvents | null
  const hookEntries = hooksContainer?.[COVERED_HOOK_EVENT]
  if (!Array.isArray(hookEntries) || !hookEntries.some(hookEntryOwned)) {
    details.push('owned PreToolUse Bash hook missing or edited')
  }
  const permissionsContainer = asMutableSettings<MutableClaudePermissions>(
    currentDocument.permissions,
  )
  const allow = permissionsContainer?.allow
  if (!Array.isArray(allow) || !allow.some(permissionRuleOwned)) {
    details.push('owned Bash(ocbox exec *) permission rule missing or edited')
  }
  if (sha256Json(baseDocument) !== sha256Json(currentDocument) && details.length === 0) {
    details.push('unrelated settings changed around owned entries; owned entries intact')
  }
  return { drifted: details.length > 0, details }
}

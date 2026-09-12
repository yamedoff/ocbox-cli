import { createHash } from 'node:crypto'
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
}

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
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

export function planMerge(document: ClaudeSettingsDocument, sessionId: string | null): MergePlan {
  const next = cloneDocument(document)
  const hooksContainer: MutableHookEvents = asMutableSettings<MutableHookEvents>(next.hooks) ?? {}
  next.hooks = hooksContainer

  const existing = hooksContainer[COVERED_HOOK_EVENT]
  const entries: unknown[] = Array.isArray(existing) ? [...existing] : []
  hooksContainer[COVERED_HOOK_EVENT] = entries

  let addedHook = false
  if (!entries.some(hookEntryOwned)) {
    entries.push({
      matcher: COVERED_HOOK_MATCHER,
      hooks: [{ type: 'command', command: buildHookCommand(sessionId) }],
    })
    addedHook = true
  }

  const permissionsContainer: MutableClaudePermissions =
    asMutableSettings<MutableClaudePermissions>(next.permissions) ?? {}
  next.permissions = permissionsContainer

  const allow = ensureStringArray(permissionsContainer, 'allow')
  let addedPermission = false
  if (!allow.some(permissionRuleOwned)) {
    allow.push(OWNED_PERMISSION_ALLOW)
    addedPermission = true
  }
  if (permissionsContainer.deny === undefined) permissionsContainer.deny = []
  if (permissionsContainer.ask === undefined) permissionsContainer.ask = []

  return {
    alreadyApplied: !addedHook && !addedPermission,
    addedHook,
    addedPermission,
    document: next,
  }
}

export interface RemovePlan {
  readonly removedHooks: number
  readonly removedPermissions: number
  readonly document: ClaudeSettingsDocument
}

export function planRemove(document: ClaudeSettingsDocument): RemovePlan {
  const next = cloneDocument(document)
  let removedHooks = 0
  let removedPermissions = 0
  const hooksContainer = asMutableSettings<MutableHookEvents>(next.hooks)
  if (hooksContainer !== null) {
    const entries = hooksContainer[COVERED_HOOK_EVENT]
    if (Array.isArray(entries)) {
      const kept = entries.filter((entry) => {
        if (hookEntryOwned(entry)) {
          removedHooks += 1
          return false
        }
        return true
      })
      hooksContainer[COVERED_HOOK_EVENT] = kept
    }
  }
  const permissionsContainer = asMutableSettings<MutableClaudePermissions>(next.permissions)
  if (permissionsContainer !== null) {
    const allow = permissionsContainer.allow
    if (Array.isArray(allow)) {
      const kept = allow.filter((rule) => {
        if (permissionRuleOwned(rule)) {
          removedPermissions += 1
          return false
        }
        return true
      })
      permissionsContainer.allow = kept
    }
  }
  return { removedHooks, removedPermissions, document: next }
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

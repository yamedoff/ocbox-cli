export {
  CAPABILITY_MATRIX,
  COVERED_CAPABILITIES,
  HOOK_EVENTS,
  HOOKABLE_TOOL_NAMES,
  ROUTING_AID_NOTICE,
  UNCOVERED_CAPABILITIES,
} from './capabilities.js'
export { ClaudeCodeAdapterError } from './errors.js'
export type { ClaudeCodeAdapterErrorCode } from './errors.js'
export { parseClaudeHookInput, runClaudeRoutingHook } from './hook.js'
export type { ClaudeHookInput, ClaudeRoutingHookOptions } from './hook.js'
export {
  cloneJson,
  deepEqual,
  getAtPointer,
  hashBytes,
  hashJson,
  isJsonObject,
  parseJsonPointer,
  stableStringify,
} from './json.js'
export type { JsonObject, JsonPrimitive, JsonValue } from './json.js'
export { detectDrift, hashOwnedValue, planMerge, planRemove, sha256Json } from './merge.js'
export type { DriftReport, MergePlan, PlanMergeOptions, RemovePlan } from './merge.js'
export type {
  DoctorResult,
  PlannerFileAccess,
  PlannerOptions,
  RemoveResult,
  SetupResult,
} from './planner.js'
export { planDoctor, planRemove as planRemoveFiles, planSetup } from './planner.js'
export type { RoutingDecision, RoutingInput } from './routing.js'
export {
  ADAPTER_ID,
  ADAPTER_ID_ENV,
  buildHookCommand,
  decideRouting,
  RECURSION_GUARD_ENV,
  recursionGuardArgs,
} from './routing.js'
export {
  collectDenyAskRules,
  COVERED_HOOK_EVENT,
  COVERED_HOOK_MATCHER,
  hasManagedHookLock,
  hookEntryOwned,
  isOwnedHookCommand,
  OWNED_HOOK_COMMAND_FRAGMENT,
  OWNED_MARKER,
  OWNED_PERMISSION_ALLOW,
  parseSettingsJson,
  permissionRuleOwned,
} from './settings-model.js'
export type {
  AdapterScope,
  ClaudeLayoutOptions,
  ClaudeSettingsLayout,
  ClaudeSettingsSource,
  ClaudeSettingsSourceEntry,
} from './settings-sources.js'
export {
  CLAUDE_SETTINGS_PRECEDENCE,
  higherPrecedenceSources,
  precedenceRank,
  resolveClaudeSettingsLayout,
  resolveClaudeSettingsSources,
  targetPathForScope,
} from './settings-sources.js'
export {
  backupPathForTarget,
  hashBackupContent,
  hashDocument,
  MANIFEST_FILENAME,
  manifestPathForTarget,
  parseManifestContent,
  readManifest,
  rollbackWrite,
} from './store.js'
export type { OwnedManifest } from './store.js'
export {
  CLAUDE_CODE_PINNED_VERSION,
  CLAUDE_CODE_SETTINGS_SCHEMA_REVISION,
  CLAUDE_CODE_VERSION_PINS,
  CLAUDE_HOOK_EVENTS,
  CLAUDE_TOOL_MATCHERS,
  detectClaudeCodeVersion,
  gateClaudeVersion,
  parseClaudeCodeVersion,
  PINNED_CLAUDE_CODE_VERSION,
  parseClaudeVersionOutput,
  settingsSchemaRevisionFor,
} from './version.js'
export type { ClaudeCodeVersionDescriptor, ClaudeHookEvent } from './version.js'

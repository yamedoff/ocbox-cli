export {
  CAPABILITY_MATRIX,
  COVERED_CAPABILITIES,
  HOOK_EVENTS,
  HOOKABLE_TOOL_NAMES,
  ROUTING_AID_NOTICE,
  UNCOVERED_CAPABILITIES,
} from './capabilities.js'
export { detectDrift, planMerge, planRemove, sha256Json } from './merge.js'
export type { DoctorResult, PlannerOptions, RemoveResult, SetupResult } from './planner.js'
export { planDoctor, planRemove as planRemoveFiles, planSetup } from './planner.js'
export type { RoutingDecision, RoutingInput } from './routing.js'
export {
  ADAPTER_ID,
  ADAPTER_ID_ENV,
  buildHookCommand,
  decideRouting,
  hookRouterShellPrelude,
  RECURSION_GUARD_ENV,
} from './routing.js'
export type {
  AdapterScope,
  ClaudeLayoutOptions,
  ClaudeSettingsLayout,
  ClaudeSettingsSource,
} from './settings-sources.js'
export { resolveClaudeSettingsLayout, targetPathForScope } from './settings-sources.js'
export {
  backupPathForTarget,
  hashDocument,
  MANIFEST_FILENAME,
  manifestPathForTarget,
} from './store.js'
export {
  gateClaudeVersion,
  PINNED_CLAUDE_CODE_VERSION,
  parseClaudeVersionOutput,
} from './version.js'

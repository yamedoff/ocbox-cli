/**
 * Adapter-irrelevant CLI flag warnings for the integrated `ocbox agent`
 * commands.
 *
 * `setup`, `doctor`, and `remove` accept the union of both adapters' flags so
 * one command shape serves `codex` and `claude-code`. A flag owned by the
 * other adapter is silently ignored by design (it never changes the plan), but
 * silence looks like acceptance: callers should be told the flag had no
 * effect. Each entry below is owned by the *other* adapter, so the warning can
 * name the owner without a second table.
 *
 * Provenance matters: `scope` defaults to `'project'`, so its mere presence in
 * parsed flags proves nothing. Callers must pass an `isProvided` check backed
 * by oclif parse metadata (`setFromDefault`), and boolean flags only warn when
 * explicitly `true`.
 */
export type AgentAdapterName = 'codex' | 'claude-code'

export type AgentCommandName = 'setup' | 'doctor' | 'remove' | 'hook'

const IRRELEVANT_FLAGS: Record<AgentCommandName, Record<AgentAdapterName, readonly string[]>> = {
  setup: {
    codex: ['scope', 'claude-version'],
    'claude-code': ['layer', 'codex-home', 'allow-unverified-schema', 'yes', 'ocbox-bin'],
  },
  doctor: {
    codex: ['scope', 'claude-version'],
    'claude-code': ['layer', 'codex-home'],
  },
  remove: {
    codex: ['scope', 'claude-version'],
    'claude-code': ['layer', 'codex-home', 'yes'],
  },
  // `hook` only takes the shared `--session` plus runtime flags, so no
  // adapter-owned flag can be irrelevant here.
  hook: { codex: [], 'claude-code': [] },
}

function ownerOf(adapter: AgentAdapterName): AgentAdapterName {
  return adapter === 'codex' ? 'claude-code' : 'codex'
}

export function irrelevantFlagWarnings(
  adapter: AgentAdapterName,
  command: AgentCommandName,
  isProvided: (flagName: string) => boolean,
): string[] {
  const owner = ownerOf(adapter)
  const warnings: string[] = []
  for (const flag of IRRELEVANT_FLAGS[command][adapter]) {
    if (!isProvided(flag)) continue
    warnings.push(`--${flag} is a ${owner}-only flag and is ignored for ${adapter}; omit it.`)
  }
  return warnings
}

/**
 * Builds the provenance check commands pass to {@link irrelevantFlagWarnings}.
 * A flag counts as provided when it holds a non-empty value the user set
 * explicitly: booleans only when `true`, strings only when oclif metadata does
 * not mark them as filled from the default (which keeps the defaulted
 * `--scope` silent unless the caller really typed it).
 */
export interface FlagMetadata {
  readonly flags?: Record<string, { readonly setFromDefault?: boolean | undefined }> | undefined
}

export function flagProvidedChecker(
  flags: Record<string, unknown>,
  metadata: FlagMetadata | undefined,
): (flagName: string) => boolean {
  return (flagName: string) => {
    const value = flags[flagName]
    if (value === undefined || value === null) return false
    if (typeof value === 'boolean') return value === true
    if (typeof value === 'string' && value.length === 0) return false
    return metadata?.flags?.[flagName]?.setFromDefault !== true
  }
}

/**
 * Emits adapter-irrelevant flag warnings on stderr so the machine-readable
 * result on stdout stays clean. Used for adapters whose planner result has no
 * warnings channel (claude-code); the codex commands fold these warnings into
 * their result payloads instead.
 */
export function warnIrrelevantFlags(
  adapter: AgentAdapterName,
  command: AgentCommandName,
  isProvided: (flagName: string) => boolean,
): void {
  for (const warning of irrelevantFlagWarnings(adapter, command, isProvided)) {
    process.stderr.write(`Warning: ${warning}\n`)
  }
}

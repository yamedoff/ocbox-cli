import { z } from 'zod'
import { CODEX_HOOK_EVENTS, type CodexHookEvent } from './hooks.js'

/**
 * Pinned Codex lifecycle-hook wire contract for the pinned shell release
 * (`codex-cli 0.153.4`). Codex normalizes the shell tool path (both the legacy
 * shell tool and unified `exec_command`) to the canonical hook tool name
 * `Bash`, and passes the shell command string in `tool_input.command`
 * (see https://developers.openai.com/codex/hooks).
 */
export const CODEX_HOOK_MATCHER_TOOL = 'Bash' as const

export const CODEX_HOOK_PAYLOAD_REVISION = 'codex-cli-0.153-hooks-v1' as const

/**
 * The pinned contract gives Codex a shell string, not argv. `ocbox exec`
 * structured argv runs exactly `/bin/bash -lc <command>`, which is the same
 * vector the CLI's explicit `--shell` mode uses, so the mapping is lossless
 * while still travelling as a structured argv after the `--` terminator.
 */
export const CODEX_HOOK_SHELL_EXECUTABLE = '/bin/bash' as const
export const CODEX_HOOK_SHELL_FLAGS = ['-lc'] as const

export const CodexShellToolInputSchema = z.object({
  command: z.string().min(1).max(1_048_576),
  workdir: z.string().max(4_096).optional(),
  shell: z.string().max(1_024).optional(),
  login: z.boolean().optional(),
  tty: z.boolean().optional(),
  yield_time_ms: z.number().finite().nonnegative().optional(),
  max_output_tokens: z.number().finite().nonnegative().optional(),
})

export type CodexShellToolInput = z.infer<typeof CodexShellToolInputSchema>

const CodexHookPayloadEnvelopeSchema = z.object({
  hook_event_name: z.string().min(1).max(64),
  session_id: z.string().min(1).max(256).optional(),
  tool_name: z.string().min(1).max(256).optional(),
  tool_input: z.unknown().optional(),
})

export interface CodexPreToolUsePayload {
  readonly hookEventName: 'PreToolUse'
  readonly sessionId: string | null
  readonly toolName: string
  /** The shell command for a covered `Bash` call, or `null` when unreadable. */
  readonly command: string | null
}

export type CodexHookPayload =
  | CodexPreToolUsePayload
  | { readonly hookEventName: Exclude<CodexHookEvent, 'PreToolUse'> }

export type CodexHookPayloadParse =
  | { readonly ok: true; readonly payload: CodexHookPayload }
  | { readonly ok: false; readonly reason: string }

const KNOWN_HOOK_EVENTS = new Set<string>(CODEX_HOOK_EVENTS)

/**
 * Reads the pinned Codex hook payload from stdin. A payload that cannot be
 * validated is rejected so the caller can fail closed rather than let a
 * covered shell call run locally.
 */
export function parseCodexHookPayload(raw: string): CodexHookPayloadParse {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'hook payload is not valid JSON' }
  }
  const envelope = CodexHookPayloadEnvelopeSchema.safeParse(parsed)
  if (!envelope.success) {
    return { ok: false, reason: 'hook payload does not match the pinned envelope' }
  }
  const event = envelope.data.hook_event_name
  if (!KNOWN_HOOK_EVENTS.has(event)) {
    return { ok: false, reason: `unknown hook event ${event}` }
  }
  if (event !== 'PreToolUse') {
    return { ok: true, payload: { hookEventName: event as Exclude<CodexHookEvent, 'PreToolUse'> } }
  }
  const toolName = envelope.data.tool_name
  if (toolName === undefined || toolName.length === 0) {
    return { ok: false, reason: 'PreToolUse payload is missing tool_name' }
  }
  let command: string | null = null
  if (toolName === CODEX_HOOK_MATCHER_TOOL) {
    const shellInput = CodexShellToolInputSchema.safeParse(envelope.data.tool_input)
    command = shellInput.success ? shellInput.data.command : null
  }
  return {
    ok: true,
    payload: {
      hookEventName: 'PreToolUse',
      sessionId: envelope.data.session_id ?? null,
      toolName,
      command,
    },
  }
}

/** Maps a covered shell command string to the pinned structured argv vector. */
export function codexShellCommandToArgv(command: string): readonly string[] {
  return [CODEX_HOOK_SHELL_EXECUTABLE, ...CODEX_HOOK_SHELL_FLAGS, command]
}

/** The documented Codex PreToolUse deny decision that blocks local execution. */
export function codexPreToolUseDenyDecision(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })
}

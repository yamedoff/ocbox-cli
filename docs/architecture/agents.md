# Coding-agent adapters: ownership and routing

## What it does
Adapters install narrowly owned hooks in supported Claude Code and Codex configurations. A covered PreToolUse event can route a command through ocbox exec into the selected Session and return a blocking decision so it is not repeated locally.

## Inside
Setup detects the executable/version and validates supported schema, configuration layers and project trust. Planners merge only owned fragments while preserving unrelated settings. Content hashes and ownership manifests let doctor/remove detect drift and identify the adapter's changes; the Codex apply writer uses the plan's captured preimage. Codex TOML edits preserve the surrounding document rather than replacing the user's configuration wholesale.

The hook reads and validates its input, applies routing/guard rules, invokes the exec runner with a recursion guard and emits the adapter's decision. Explicit allow-local routes return without blocking; covered remote routes and guard refusals emit a deny decision. Malformed input or an execution that never starts fails closed.

## Data it keeps
Owned fragment manifests, backups, original content hashes and selected configuration-layer paths. Agent settings remain the user's files. Tokens are read through the CLI credential boundary, not stored in hook configuration.

## States
Detected → source files read → planned → applied and owned; failure → rollback. Codex does not repeat the file-hash check between planning and apply. Doctor reports drift/capability/trust findings. Removal deletes only ownership-proven fragments; ambiguity is reported instead of overwriting unrelated settings.

## Limits and config
Both adapter source timeout contracts configure a 600-second hook deadline, a 30-second decision margin and a 570000 ms remote exec timeout. Version pins and live capability gates are recorded in each adapter's version/capabilities files. These are repository contracts; this architecture work does not claim a new installed-agent live acceptance run.

## When it fails
Unsupported versions, untrusted project configuration, managed hook locks, overlapping rules, file drift and missing ownership evidence stop the relevant write or route. applyCodexChangePlan writes a previously computed plan and rolls back completed writes after a later failure. It does not re-read target fingerprints immediately before apply; changes made after planning can be overwritten. Hook timeout/cancellation is distinct from the remote command's exit code.

## Code evidence
Claude policy/setup/remove: `src/agents/claude-code/planner.ts:272–502,746–885`. Codex planning/apply/doctor: `src/agents/codex/planner.ts:452–814,1227–1571`, `src/commands/agent/setup.ts:47–181`. Routing: `src/agents/codex/hook-helper.ts:80–149`, `hook.ts:66–155`; timeout/version constants are in each adapter's `timeouts.ts` and `version.ts`.

Verified against ocbox-cli @ d949442bca48a5e84b7f0a26c51a1f83b07bd202

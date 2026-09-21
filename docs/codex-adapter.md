# Codex adapter: setup, remove, and manifest recovery

`ocbox agent setup codex` installs a reversible routing aid into the Codex
configuration and records what it owns in a per-layer manifest
(`<state>/agents/codex/<user|project>/manifest.json`).
`ocbox agent remove codex` removes only that owned content and restores the
pre-existing file bytes when it can prove the originals. `ocbox agent doctor
codex` reports version, precedence, drift, and capability checks without
writing. This is a routing aid, not host isolation and not a security
boundary.

## Plan/apply setup

Setup is explicit and two-phased. Without `--yes` it only prints the plan
(`ok`, `changes`, `errors`, `warnings`, `liveBlocker`); with `--yes` it
applies the same plan. Re-running setup with a matching manifest is
idempotent (`alreadyApplied`, status `unchanged`).

```sh
ocbox agent setup codex --layer user --session SESSION_ID
ocbox agent setup codex --layer user --session SESSION_ID --yes
ocbox agent setup codex --layer project --project-dir . --session SESSION_ID --yes
```

Setup refuses fail-closed (no writes) when any blocker holds:

- the installed `codex --version` is not the pinned shell release (`0.153.4`;
  Desktop pre-releases and unknown schemas are refused rather than guessed);
- the `project` layer is selected but the repository is not trusted in Codex
  (the project layer is never auto-trusted; use `--layer user` instead);
- there is no usable Session, or an explicit `--session` is not recorded in
  lifecycle state;
- `config.toml`/`hooks.json` is unparseable, the hooks schema is unknown, or
  the pinned offline hook contract cannot be proven.

Exit codes preserve the machine-readable output: plan mode (no `--yes`) still
emits the full plan envelope on stdout but exits `2` when blockers hold, so a
script cannot mistake a refused plan for an approved one. `--yes` with
blockers throws before writing and exits `1`. Success and clean plans exit
`0`.

`--allow-unverified-schema` is a deprecated no-op: the pinned schema gate now
proves the hooks shape, so setup proceeds without it. Passing the flag emits a
deprecation warning; omitting it is silent.

A flag owned by the other adapter (for example `--scope` or
`--claude-version`) is ignored and produces an explicit warning naming the
flag, so it is never mistaken for an accepted option.

## Remove and restore

```sh
ocbox agent remove codex --layer user
ocbox agent remove codex --layer all --yes
```

`remove` plans per layer (`user`, `project`, or `all`, default `all`) and only
writes with `--yes`. Per file the plan is one of `restore` (backup bytes are
provable), `strip-owned`, `delete` (adapter-created file), `preserve-and-plan`
(unrelated drift with no backup: the current file is copied aside to a
`.ocbox-preserved` sibling and the owned content is pruned), or `noop`.
`repairSteps` tells the operator how to finish by hand.

When a user edits an owned fragment, `remove` reports `repair-required` and
writes nothing: the edited copy is preserved rather than destroyed, and the
`repairs` entries identify the fragment (`user-modified-owned-fragment`).
Rotating to a new `--session` replaces the owned hook instead of accumulating
copies, and a duplicated owned copy in both representations is pruned back to
one representation per layer (`duplicated-representation`).

## Manifest recovery

Each layer owns a manifest recording the adapter version, Codex version,
schema revision, representation, target paths, session, owned fragments,
content hashes, created-file flags, and backup paths. Recovery rules:

- A corrupted per-layer manifest warns (`Adapter manifest is corrupted;
  treating setup as not applied`) and is treated as absent; it is never
  trusted for restoration.
- A legacy single-layer manifest (`<state>/agents/codex/manifest.json`) is
  still honored: setup and remove recover its fragments by strict ownership
  and record a per-layer manifest, warning that the legacy file exists.
- Without any manifest, `remove` falls back to ownership matching instead of
  byte restoration: only strictly owned fragments are pruned, so co-located
  user hooks survive, but original formatting cannot be recovered.
- True pre-ownership bytes are only restorable from a recorded backup. Without
  the manifest there is no trusted `backupPath`, so `remove` prunes textually
  rather than restoring bytes.

## Hook exits and timeouts

The installed entrypoint is `ocbox agent hook codex --session SESSION_ID`.
It reads one pinned PreToolUse JSON payload from stdin
(`hook_event_name`, `tool_name`, `tool_input.command`; covered tool `Bash`),
routes covered shell calls through `ocbox exec --session ... -- /bin/bash -lc
<command>` with recursion-guard env markers
(`OCBOX_CODEX_ADAPTER_ACTIVE=1`, `OCBOX_CODEX_ADAPTER=codex`), and prints the
documented deny decision
(`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}`)
on stdout.

Exit contract:

- `0` — the call is outside coverage (left local, stdout untouched), or a
  covered call was routed and the deny decision was emitted. The decision
  reason reports the honest remote outcome (`... ocbox exec (exit <n>) ...`),
  including a legitimate remote exit `2`, which is never confused with the
  adapter's own block.
- `2` — fail-closed: unreadable payload, covered call with no usable Session,
  unknown adapter, or an unexpected stdin/exec/writer failure inside the
  `runCodexAgentHookSafely` boundary (redacted before it crosses the
  boundary).

Stdout discipline is byte-exact by construction: routed command output is
redirected to stderr (both hook invokers share one IO mapper), so stdout
carries only the single JSON decision line.

Unlike the Claude Code adapter, the Codex adapter pins no hook-deadline
constant: there is no `timeout` written onto the installed hook and no
`--timeout` on the routed `ocbox exec`, which therefore inherits the default
execution timeout. The `codex --version` probe that gates setup carries its
own 15-second timeout and yields an empty string on any failure, which the
pinned-version gate reports as an unsupported install.

## Windows discovery

- `CODEX_HOME` (or `--codex-home`) selects the user configuration root and
  must be absolute; otherwise the adapter uses `<home>/.codex` with
  platform-native joins (backslashes on `win32`).
- The `codex` executable is found by scanning `PATH` entries for `codex` and
  `codex.exe` (split on `;` when present, else `:`).
- Project-trust keys are normalized before comparison (leading `\\?\`
  stripped, backslashes to slashes, trailing slashes trimmed,
  case-insensitive), so `C:\Users\Ada\Repo` matches its TOML entry.
- The project layer lives at `<project>/.codex/` and every write is confined
  to the layer root (`CODEX_UNSAFE_PATH` otherwise).

## Byte-preserving behavior

`config.toml` is edited by byte-splicing the owned hook groups: comments,
ordering, and unrelated tables survive untouched, and only strictly owned or
verified-legacy fragments are ever removed. `hooks.json` is normalized to
two-space JSON on write, so it is semantically (not byte-) preserving:
unrelated hooks and keys are kept, but formatting is not. Every applied change
records a backup path (`.ocbox-backup`), and applying is crash-safe: a failed
later write rolls back the earlier writes. `doctor` checks (`config-parse`,
`hooks-parse`, `hook-representation`, `orphaned-hooks`, `owned-entries`,
`selected-session`, `provider-readiness`, `schema-proof`, `hook-contract`,
`recursion-guard`, `project-trust`) report drift without writing.

Setup always carries the `liveBlocker` string: live Codex E2E against the
pinned version (setup, remote shell task, drift detection, remove/restore) has
not been run, and remains the named blocker after the offline proof.

Covered by `test/agents/codex/*` and `test/commands/agent/*`.

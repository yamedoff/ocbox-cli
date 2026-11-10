# ocbox CLI: architecture and boundaries

## What it does

The CLI is an application on the developer's machine. It authenticates, keeps a local project/Session selection, uploads source and runs commands through the public API. It also installs owned coding-agent hooks. It contains client orchestration, not the hosted service implementation.

## Inside

The map has one active application building with fourteen areas: commands, auth, lifecycle, execution, sync, agents, state, hosted API, provider contract, domain validation, project configuration, output, typed errors, and redaction with path safety. The old Local state building is deprecated and kept for its human notes. Coding agents remain an outside caller.

The command runtime builds a LifecycleService, an authenticated generated client and the selected provider. The registry wires the hosted ocbox provider and a fake provider used for local validation. Provider interfaces describe capabilities; having a method in an interface does not prove that staging supports it.

`init` checks a saved hosted project against the signed-in account before reporting the config as validated. A project the account cannot see fails with the reset step instead of letting `start` fail later. New hosted configs omit image, region and resource overrides so the server chooses its free default; the fake placeholders remain for the offline provider and its tests only.

## Warm session cache

`ocbox exec` may start one optional local daemon on first use. It listens on an owner-only socket in the user's runtime directory (a named pipe on Windows), keeps one owned hosted Session observation and its authenticated API client warm, and exits after an idle timeout. The first command reads the Session once; a later command reuses the observation, so it makes no extra box read. If the socket is absent, stale, or slow, or `OCBOX_WARM=0` is set, the command falls back to the direct API path. A cached observation is advisory: the execution start remains authoritative for a state change the daemon has not seen. The daemon never writes session state or credentials to disk. `scripts/measure-cli-latency.mjs` runs the same command repeatedly and reports p50/p95 of CLI wall time minus the product's recorded execution window.

## Data it keeps

Project configuration is separate from machine metadata, protected OAuth credentials, Session mappings, operation checkpoints, agent ownership manifests and local transfer journals. Remote product records belong to the API. Local files never contain the server's provider credentials or implementation configuration.

## States

Login establishes an issuer/client/audience-bound credential generation. A selected local Session is reconciled with the hosted Session before execution. Hosted execution uses the API directly; only the fake provider uses the local helper. Explicit shell mode rejects a known non-Linux OS and defers unknown effective OS compatibility to the remote executor. Upload and execution are asynchronous: requests return handles, and bounded observations converge to a result. An unknown outcome remains recoverable rather than being labelled successful.

## Limits and config

The vendored OpenAPI file and generated client define the server contract; provenance and api:check detect drift. Runtime configuration selects API base, hosted project, state directory and resource request. Source push uses v2 for mapped `sesdo_` Sessions: hash/bundle/page, up to four concurrent capability PUTs, then apply polling with unsigned local resume state. Legacy Sessions retain archive upload. Caps and refusals are detailed in Source and sync. The shared map engine has no vendor catalogue; repository-owned dependency declarations classify all imported packages.

## When it fails

Invalid configuration, unsupported capabilities, stale credentials, an absent Session and incomplete remote work have distinct typed errors. General command envelopes are redacted. Exec separately streams command bytes, or base64 in JSON/JSONL, and includes only curated error details. The public repo explains what its client sends and observes; the private repo explains how the server performs that work.

Opaque source upload endpoints are an outside building: their capability URLs prove a direct PUT path, without identifying infrastructure or another repository's implementation.

## Read and play

Start with Sign in from the CLI, Start a box from the CLI, Push local files to the box and Run a command from the CLI. Public API connection IDs bridge these client stories to server journeys in Notion. This guide describes source behavior at the commit below; it is not a new live product acceptance report.

Execution failures after an accepted start use the same safe typed code/message as failures before start. Human output prints the safe message; JSON and JSONL include the existing optional error detail. Infrastructure failure still exits 125 and remains distinct from a command whose own exit code is 125. Unknown error causes keep the generic envelope and are not serialized. This also applies to errors while collecting events or reading a final result; the event collector still has a separate best-effort tail drain after fallback, which can complete without recovering every output event.

## Code evidence

Composition and entry points: `src/cli/runtime.ts:117–280`, `src/commands/exec.ts:59–71`, `src/execution/service.ts:58–214`, `src/execution/command-runner.ts:118–230`, `src/providers/ocbox/provider.ts:427–470,507–616,1096–1223`.

Warm session cache: `src/warm/paths.ts`, `src/warm/protocol.ts`, `src/warm/daemon.ts`, `src/warm/daemon-main.ts`, `src/warm/client.ts`; measurement: `scripts/measure-cli-latency.mjs`.

Verified against ocbox-cli @ 06da359

Sign-in errors map closed public server reasons to static text and retain the server reference. The five-minute loopback deadline reports when the browser never returned. Local status errors distinguish missing metadata, unreadable state and mismatched identity/generation; the fix is logout then login using the same state directory. Logout returns revocationReason, including missing/unreadable state and invalid endpoint cases. The auth command boundary stores the last 100 failure references (at most seven days) in auth-failures.json through the atomic store; it stores no error text or sign-in material. Look up a local reference in that file; server references belong to the public API support flow.

Verified against ocbox-cli @ cd231a4 plus auth failure reporting changes.

`init` verifies a saved hosted project against the signed-in account, and hosted configs omit the offline image/region placeholders so status shows the server's observed default.

Verified against ocbox-cli @ 872e6f2 plus the init project-check and hosted-default changes.

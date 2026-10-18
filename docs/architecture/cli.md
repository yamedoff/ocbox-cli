# ocbox CLI: architecture and boundaries

## What it does
The CLI is an application on the developer's machine. It authenticates, keeps a local project/Session selection, uploads source and runs commands through the public API. It also installs owned coding-agent hooks. It contains client orchestration, not the hosted service implementation.

## Inside
The map has one active application building with ten areas: commands, auth, lifecycle, execution, sync, agents, state, hosted API, provider contract and domain validation. The old Local state building is deprecated and kept for its human notes. Coding agents remain an outside caller.

The command runtime builds a LifecycleService, an authenticated generated client and the selected provider. The registry wires the hosted ocbox provider and a fake provider used for local validation. Provider interfaces describe capabilities; having a method in an interface does not prove that staging supports it.

## Data it keeps
Project configuration is separate from machine metadata, protected OAuth credentials, Session mappings, execution checkpoints, agent ownership manifests and local transfer journals. Remote product records belong to the API. Local files never contain the server's provider credentials or implementation configuration.

## States
Login establishes an issuer/client/audience-bound credential generation. A selected local Session is reconciled with the hosted Session before execution. Upload and execution are asynchronous: requests return handles, and bounded observations converge to a result. An unknown outcome remains recoverable rather than being labelled successful.

## Limits and config
The vendored OpenAPI file and generated client define the server contract; provenance and api:check detect drift. Runtime configuration selects API base, hosted project, state directory and resource request. Source upload caps and capability refusals are detailed in Source and sync. The shared map engine has no vendor catalogue; repository-owned dependency declarations classify all imported packages.

## When it fails
Invalid configuration, unsupported capabilities, stale credentials, an absent Session and incomplete remote work have distinct typed errors. Human, JSON and JSONL outputs share a redacted result contract. The public repo explains what its client sends and observes; the private repo explains how the server performs that work.

## Read and play
Start with Sign in from the CLI, Start a box from the CLI, Push local files to the box and Run a command from the CLI. Public API connection IDs bridge these client stories to server journeys in Notion. This guide describes source behavior at the commit below; it is not a new live product acceptance report.

Execution failures after an accepted start use the same safe typed code/message as failures before start. Human output prints the safe message; JSON and JSONL include the existing optional error detail. Infrastructure failure still exits 125 and remains distinct from a command whose own exit code is 125. Unknown error causes keep the generic envelope and are not serialized. This also applies to errors while collecting events or reading a final result; it does not turn an unavailable event history into successful command output.

Verified against ocbox-cli @ 8af54e8 (source base; execution error changes verified in this commit)

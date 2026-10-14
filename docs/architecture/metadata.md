# CLI metadata, configuration and capabilities

## What it does
Project and environment commands use the public metadata client without requiring a selected sandbox. init can complete hosted project onboarding; provider diagnostics and configuration/spec validation are local entry points. Other provider operations remain capability-gated.

## Inside
createMetadataClient builds an issuer-bound authenticated client. dispatchMetadataAction covers project list/create/get/update and environment list/create/get/update. Generated-client response shapes are checked again at the metadata boundary; server request IDs and replay facts are retained safely.

Command classes parse identifiers, names, pagination and idempotency flags before dispatch. Runtime composition registers ocbox and fake providers. Requested specifications are validated against domain schemas; a provider name/capability refusal is reported rather than turned into a successful no-op.

## Data it keeps
Project configuration, selected IDs and public metadata response views. The hosted service remains authoritative for remote project/environment ownership. The generated client is pinned to vendored OpenAPI provenance; this repo contains no server implementation.

## States
Parsed configuration → validated public request → typed API result or refusal. Mutations carry an idempotency key. Read/list commands do not mutate the hosted workspace. Initialization can look up or create project metadata when hosted onboarding lacks a project ID, then write validated local config.

## Limits and config
Metadata names are 1–200 characters; list limits are 1–100. The selected API base and deployment subpath govern where credentials may be sent. Public capabilities and source behavior are separate from staging feature enablement.

## When it fails
Invalid identifiers, bad response shape, authentication/ownership failure, capability refusal and transport cancellation remain typed errors. Snapshot and preview support must be checked at the provider/capability boundary; this guide does not equate an interface definition with a deployed feature.


## Initialization onboarding
`src/cli/runtime.ts:196-280` validates existing config, selects hosted after login or fake otherwise unless overridden, and may page projects by the directory name or create a project if no ID is configured. Repeated cursors fail. New config uses exclusive create, mode 0600 and sync; changed existing config is written after validation. No overwrite flag is defined on init (`src/commands/init.ts:5-23`).


## Source responsibilities

These source definitions are the navigation index for the responsibilities above. Line ranges refer to the verified source snapshot.

| Responsibility | Source |
| --- | --- |
| ocbox start | `src/commands/start.ts:6-39` |
| ocbox exec | `src/commands/exec.ts:46-72` |
| ocbox sync push | `src/commands/sync/push.ts:12-46` |
| ocbox destroy | `src/commands/destroy.ts:24-64` |
| ocbox auth login | `src/commands/auth/login.ts:6-59` |
| createLifecycleService | `src/cli/runtime.ts:167-193` |
| readStandardInput | `src/commands/agent/hook.ts:21-27` |
| removeCodexLayer | `src/commands/agent/remove.ts:45-129` |
| parseCodexLayer | `src/commands/agent/setup.ts:41-45` |
| PROVIDER_NAME_PATTERN | `src/domain/entities.ts:18-35` |
| canTransitionSessionState | `src/domain/lifecycle.ts:39-41` |
| OPERATION_ACTIONS | `src/domain/operation.ts:12-28` |
| SandboxSpecSchema | `src/domain/spec.ts:200-213` |
| effectiveMaxSandboxesPerSession | `src/providers/contract/capabilities.ts:100-104` |
| CreateSandboxRequestSchema | `src/providers/contract/provider.ts:24-39` |
| FakeSandboxProvider.create | `src/providers/fake/provider.ts:346-347` |
| AgentDoctor.run | `src/commands/agent/doctor.ts:166-197` |
| AgentHook.run | `src/commands/agent/hook.ts:264-306` |
| AgentTopic.run | `src/commands/agent/index.ts:32-34` |
| AgentRemove.run | `src/commands/agent/remove.ts:217-248` |
| AgentSetup.run | `src/commands/agent/setup.ts:233-264` |
| AuthTopic.run | `src/commands/auth/index.ts:22-24` |
| AuthLogin.run | `src/commands/auth/login.ts:24-58` |
| AuthLogout.run | `src/commands/auth/logout.ts:10-14` |
| AuthStatus.run | `src/commands/auth/status.ts:10-14` |
| Cancel.run | `src/commands/cancel.ts:25-43` |
| Destroy.run | `src/commands/destroy.ts:32-63` |
| EnvironmentCreate.run | `src/commands/environment/create.ts:19-26` |
| EnvironmentGet.run | `src/commands/environment/get.ts:11-16` |
| EnvironmentList.run | `src/commands/environment/list.ts:17-24` |
| EnvironmentUpdate.run | `src/commands/environment/update.ts:23-31` |
| Exec.run | `src/commands/exec.ts:59-71` |
| Init.run | `src/commands/init.ts:15-23` |
| ListSessions.run | `src/commands/ls.ts:9-17` |
| Pause.run | `src/commands/pause.ts:13-23` |
| ProjectCreate.run | `src/commands/project/create.ts:12-18` |
| ProjectGet.run | `src/commands/project/get.ts:11-16` |
| ProjectList.run | `src/commands/project/list.ts:11-17` |
| ProjectUpdate.run | `src/commands/project/update.ts:19-26` |
| Providers.run | `src/commands/providers.ts:10-35` |
| Start.run | `src/commands/start.ts:13-38` |
| Status.run | `src/commands/status.ts:13-18` |
| Stop.run | `src/commands/stop.ts:13-23` |
| SyncDiff.run | `src/commands/sync/diff.ts:23-29` |
| SyncTopic.run | `src/commands/sync/index.ts:24-26` |
| SyncPull.run | `src/commands/sync/pull.ts:32-44` |
| SyncPush.run | `src/commands/sync/push.ts:32-45` |
| SyncRecover.run | `src/commands/sync/recover.ts:20-26` |
| Use.run | `src/commands/use.ts:11-16` |

Verified against ocbox-cli @ 8af54e8

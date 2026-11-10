# CLI metadata, configuration and capabilities

## What it does
Project and environment commands use the public metadata client without requiring a selected sandbox. init performs local configuration onboarding and may list/create a hosted project; provider diagnostics and configuration/spec validation are other entry points. Other provider operations remain capability-gated.

## Inside
createMetadataClient builds an issuer-bound authenticated client. dispatchMetadataAction (`src/metadata/client.ts:123–231`) covers project list/create/get/update and environment list/create/get/update. Generated-client response shapes are checked again at the metadata boundary; server request IDs and replay facts are retained safely.

Command classes parse identifiers, names, pagination and idempotency flags before dispatch. Runtime composition registers ocbox and fake providers. Requested specifications are validated against domain schemas; a provider name/capability refusal is reported rather than turned into a successful no-op.

## Data it keeps
Project configuration, selected IDs and public metadata response views. The hosted service remains authoritative for remote project/environment ownership. The generated client is pinned to vendored OpenAPI provenance; this repo contains no server implementation.

## States
Parsed configuration → validated public request → typed API result or refusal. Mutations carry an idempotency key. Read/list commands do not mutate the hosted workspace. Initialization creates its owned configuration file exclusively or validates/completes an existing one; it can also create a hosted project.

## Limits and config
Metadata names are 1–200 characters; list limits are 1–100. The selected API base and deployment subpath govern where credentials may be sent. Public capabilities and source behavior are separate from staging feature enablement.

## When it fails
Invalid identifiers, bad response shape, authentication/ownership failure, capability refusal and transport cancellation remain typed errors. Preview create/revoke and hosted Session listing are callable provider ports, with no corresponding CLI command. cancelHostedOperation is an exported helper, also unused by CLI commands; it returns a validated cancel response without waiting for terminal cancellation.

## Code evidence
CRUD dispatch and strict schemas: `src/metadata/client.ts:18–50,83–231`. Cancellation/output: `src/metadata/command.ts:41–73`. Onboarding: `src/cli/runtime.ts:196–280`; optional provider ports: `src/providers/ocbox/provider.ts:636–669,1302–1395`, `src/providers/ocbox/operations.ts:399–486`.

Verified against ocbox-cli @ d949442bca48a5e84b7f0a26c51a1f83b07bd202

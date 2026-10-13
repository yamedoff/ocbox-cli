# CLI metadata, configuration and capabilities

## What it does
Project and environment commands use the public metadata client without requiring a selected sandbox. init, presets, provider diagnostics and configuration/spec validation are local entry points. Other provider operations remain capability-gated.

## Inside
createMetadataClient builds an issuer-bound authenticated client. dispatchMetadataAction covers project list/create/get/update and environment list/create/get/update. Generated-client response shapes are checked again at the metadata boundary; server request IDs and replay facts are retained safely.

Command classes parse identifiers, names, pagination and idempotency flags before dispatch. Runtime composition registers ocbox and fake providers. Requested specifications are validated against domain schemas; a provider name/capability refusal is reported rather than turned into a successful no-op.

## Data it keeps
Project configuration, selected IDs and public metadata response views. The hosted service remains authoritative for remote project/environment ownership. The generated client is pinned to vendored OpenAPI provenance; this repo contains no server implementation.

## States
Parsed configuration → validated public request → typed API result or refusal. Mutations carry an idempotency key. Read/list commands do not mutate the hosted workspace. Local presets/initialization modify only their owned configuration files.

## Limits and config
Metadata names are 1–200 characters; list limits are 1–100. The selected API base and deployment subpath govern where credentials may be sent. Public capabilities and source behavior are separate from staging feature enablement.

## When it fails
Invalid identifiers, bad response shape, authentication/ownership failure, capability refusal and transport cancellation remain typed errors. Snapshot and preview support must be checked at the provider/capability boundary; this guide does not equate an interface definition with a deployed feature.

Verified against ocbox-cli @ 4a917c828da6

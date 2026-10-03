# OpenCloudBox CLI

`ocbox` is the public command-line interface for OpenCloudBox. The current v0.1
surface contains the oclif shell, provider-neutral domain and adapter contracts,
the execution engine/helper boundary, the manifest-based `sync diff|push|pull`
source transport, and OAuth 2.1 PKCE CLI authentication. Provider integrations
remain out of scope.

Library consumers import the side-effect-free contract entrypoint without
starting the CLI:

```ts
import { SandboxSpecSchema, type SandboxProvider } from 'opencloudbox/contracts'
```

See [docs/contracts.md](docs/contracts.md) for lifecycle, specification,
idempotency, execution, file, preview, and error invariants. See
[docs/execution.md](docs/execution.md) for command grammar, streaming, cancellation,
exit behavior, and the deliberately local fake-provider harness. See
[docs/sync.md](docs/sync.md) for the manifest, path/secret policy, three-way
planner, deletion confirmation, and staging/recovery contract. See
[docs/auth.md](docs/auth.md) for the OAuth 2.1 PKCE login/logout/status contract,
token lifecycle, and the pinned hosted OpenAPI artifact. See
[docs/claude-code-adapter.md](docs/claude-code-adapter.md) for the Claude Code
routing adapter's setup/remove behavior and its manifest-loss reconstruction
limits. See [docs/codex-adapter.md](docs/codex-adapter.md) for the Codex
routing adapter's plan/apply setup, remove/restore behavior, manifest
recovery, hook exit contract, Windows discovery, and byte-preserving edits.

## Hosted project and environment onboarding

After `ocbox auth login --api-url https://your-api.example`, set `OCBOX_API_URL`
to that same API base (or pass `--api-url` on each metadata command). Metadata
commands use the protected, issuer-bound login credential and work before a
hosted project has been selected. They never accept a static environment bearer.

```sh
ocbox project list --limit 20 --json
ocbox project create --name "My project" --idempotency-key onboarding-project-001 --json
ocbox project get --project-id PROJECT_ID --json
ocbox project update --project-id PROJECT_ID --name "My renamed project" --json
ocbox environment list --project-id PROJECT_ID --json
ocbox environment create --project-id PROJECT_ID --name development --json
ocbox environment get --environment-id ENVIRONMENT_ID --json
ocbox environment update --environment-id ENVIRONMENT_ID --selected true --json
```

Replace the ID placeholders with the IDs returned by create/list. List commands
return one bounded page; pass its `nextCursor` to `--cursor` for the next page.
Mutation commands accept `--idempotency-key` for a safe retry across invocations;
otherwise they generate a new UUID per invocation. Environment update accepts
`--name`, `--selected true`, or `--selected false` and requires at least one.

For hosted lifecycle commands such as `start`, use the existing provider config
(`provider.name = "ocbox"`) and set `OCBOX_PROJECT_ID` to the returned hosted
project ID in the same shell. Metadata commands do not persist project selection
or rewrite `opencloudbox.toml`. Server environment selection is metadata and does
not replace the existing sandbox specification's environment configuration.
Use `--state-dir` consistently with login if you override the auth state root.

## Toolchain

- Node.js `24.20.0`
- Corepack `0.36.0`
- pnpm `11.24.0`

Install the exact Corepack release, activate the pinned package manager, and use
the committed lockfile:

```sh
npm install --global corepack@0.36.0
corepack enable
corepack prepare pnpm@11.24.0 --activate
pnpm install --frozen-lockfile
```

GitHub Codespaces uses the committed `.devcontainer` configuration to install
and verify this exact toolchain, enable `gh codespace ssh`, and run the frozen
install automatically whenever a codespace is created or rebuilt.

The package is named `opencloudbox` at version `0.1.0`, but publication is
disabled with `private: true` until a later registry and release review. Both
`ocbox` and `opencloudbox` resolve to the same built entrypoint.

## Validate

```sh
pnpm run api:check
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test
pnpm run build
pnpm run cli:smoke
pnpm run dependencies:check
pnpm run licenses:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and
[docs/dependency-policy.md](docs/dependency-policy.md) for pinning policy.

# OpenCloudBox CLI

`ocbox` is the public command-line interface for OpenCloudBox. The current v0.1
surface contains the oclif shell, provider-neutral domain and adapter contracts,
the execution engine/helper boundary, the manifest-based `sync diff|push|pull`
source transport, and OAuth 2.1 PKCE CLI authentication. Hosted lifecycle commands use the issuer-bound login credential.

## Install

Requires Node.js ≥22.

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/yamedoff/ocbox-cli/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/yamedoff/ocbox-cli/main/install.ps1 | iex
```

These commands work once the first release is published; until then install with `npm i -g opencloudbox`.

The install scripts place `ocbox` in `~/.ocbox` (`%LOCALAPPDATA%\ocbox` on
Windows), verify the release checksum, and add the bin folder to PATH (printing
the line to add on macOS and Linux when it is not already there). To install
from npm instead:

```sh
npm i -g opencloudbox
ocbox --help
```

The `opencloudbox` command is also available as an alias for `ocbox`.

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

## Your first box

This walkthrough takes a new project from the install command above to a
destroyed box. It uses the hosted staging service.

### 1. Check the install

Install with the command for your platform above, then confirm the CLI runs:

```sh
ocbox --version
```

```text
opencloudbox/0.1.0 linux-x64 node-v24.20.0
```

### 2. Sign in

```sh
ocbox auth login
```

The browser opens the consent page. After you approve access:

```text
Logged in issuer=https://api.staging.opencloudbox.dev audience=cli scopes=source:read product:read product:edit product:run expires=2026-12-01T09:00:00.000Z (browser opened)
```

### 3. Initialize the project

Create or enter the project you want to run, then initialize it:

```sh
mkdir hello-box && cd hello-box
ocbox init
```

```text
Created project prj_7f3c2a1b9d ("hello-box") and wrote opencloudbox.toml
Using the hosted OpenCloudBox provider (staging at https://api.staging.opencloudbox.dev).
```

`init` reuses a hosted project with the current directory's name, or creates
one and saves its ID in `opencloudbox.toml`.

### 4. Start the box

```sh
ocbox start
```

```text
* session=3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b state=active project=prj_7f3c2a1b9d provider=running raw=running
Next: ocbox sync push
```

`start` creates a box for the project, or resumes the selected one. The `Next:`
line points at the source push the new box is waiting for.

### 5. Push the source

```sh
printf 'hello from the box\n' > hello.txt
ocbox sync push
```

```text
Source synced: 1 addition(s), 0 modification(s), 0 deletion(s); uploaded 1 blob(s), 19 bytes.
hello.txt
```

Dependency and build folders such as `node_modules` are left out on purpose;
when a lockfile is pushed, the output ends with the install command to run in
the box.

### 6. Run a command and read its output

```sh
ocbox exec --timeout-seconds 60 -- cat hello.txt
```

```text
execution exe_9d6b3eb74aae3741801b93a37e4ff2 started; reattach with: ocbox execution get exe_9d6b3eb74aae3741801b93a37e4ff2
hello from the box
```

The command runs in the box's workspace, where `sync push` put the files.
Tokens after `--` are passed to the program unchanged. The execution ID lets
you reattach after a disconnect with `ocbox execution get <id>`.

### 7. Stop the box

```sh
ocbox stop
```

```text
* session=3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b state=stopped project=prj_7f3c2a1b9d provider=stopped raw=stopped
```

Stopping keeps the box's filesystem. Start it again with `ocbox start`.

### 8. Destroy the box

```sh
ocbox destroy --yes
```

```text
  session=3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b state=destroyed project=prj_7f3c2a1b9d provider=unbound raw=unbound
```

Destroying discards the box and its filesystem. To start a fresh box, run
`ocbox start` again.

## Sync to a hosted sandbox

After `ocbox init` and `ocbox start`, upload your current project before running it:

```sh
ocbox sync push
ocbox exec -- cat a.txt
ocbox sync push --exclude 'fixtures/**' --exclude large.bin
```

Hosted push uses the selected sandbox's persisted session mapping and the
content-addressed v2 sync API, with the v3 fast apply when the server supports
it. The server delivers the files under `/workspace/<projectId>`; hosted
commands run from that project directory. Push reports uploaded paths and file
bytes, and an unchanged push sends no blobs. The retired archive and
manifest/chunk upload route is no longer used.

Hosted sync limits are 100,000 entries, 256 MiB per file and 1 GiB total
content; manifest pages hold 512 entries and 512 KiB. Oversized or unsafe paths
fail before upload and identify paths to exclude with `--exclude` or
`.opencloudboxignore`. Existing ignore, secret, and path rules also apply.

Hosted `sync pull` and `sync diff` use the CAS snapshot API. Hosted
`sync recover` is not supported. `--remote-dir` is available for the offline
fake provider only, which retains its local workspace, three-way planning, and
recovery behavior.

## Hosted project and environment onboarding

Log in once, then initialize and run a hosted sandbox without environment variables:

```sh
ocbox auth login
ocbox init
ocbox start
ocbox exec -- node --version
```

The default API is staging (`https://api.staging.opencloudbox.dev`), switched to
production at launch via `DEFAULT_API_URL`. `--api-url` and `OCBOX_API_URL`
override it. `init` reuses a project named after the current directory or creates
one and saves its ID in `opencloudbox.toml`. Project selection is `--project`,
then `OCBOX_PROJECT_ID`, then the saved ID. Use `ocbox init --provider fake` for
the offline harness. Hosted configs omit resource overrides by default so the
server chooses the free tier. Optional `--cpu` (cores), `--memory` (bytes),
`--image`, `--region`, and `--runtime` request explicit resources.

Metadata commands also use the protected login credential:

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

The installed-CLI acceptance harness packs and installs the CLI into an isolated
directory and exercises login and the hosted journey. Its offline self-test uses
a local HTTP fixture:

```sh
node scripts/accept-installed.mjs --self-test
node scripts/accept-installed.mjs --api-url https://api.example.test
```

To run against the hosted service with a test mailbox, set
`OCB_TEST_MAILBOX_API_KEY`, `OCB_TEST_MAILBOX_NAMESPACE`,
`OCB_TEST_MAILBOX_API_URL`, `OCB_TEST_MAILBOX_DOMAIN`, and
`OCB_ACCEPT_WEB_ORIGIN`, then run
`node scripts/accept-installed.mjs --api-url <hosted API origin>`.
The test mailbox adapter polls tagged messages from the email provider.
Without the mailbox credentials, login waits for manual browser authorization.
Add `--verbose` to print sub-step methods, paths without query values, statuses,
and durations to stderr. Credentials and mailbox bodies stay out of evidence
and the installed CLI's environment.

Use `ocbox cancel [execution-id] [--sandbox <local-id>]` from any terminal to cancel an execution; `--wait-timeout` bounds the wait in milliseconds.

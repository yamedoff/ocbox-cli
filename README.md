# OpenCloudBox CLI

`ocbox` is the public command-line interface for OpenCloudBox. The current v0.1
surface contains the oclif shell, provider-neutral domain and adapter contracts,
the execution engine/helper boundary, the manifest-based `sync diff|push|pull`
source transport, and OAuth 2.1 PKCE CLI authentication. Hosted lifecycle commands use the issuer-bound login credential.

## Install

Building from source needs Node.js 24.20.0 and the pinned pnpm from
[Toolchain](#toolchain). `package.json` pins that Node version in `devEngines`
with `onFail: error`, so `pnpm install --frozen-lockfile` and `pnpm run
pack:release` refuse any other version. The installed CLI itself only needs
Node.js >=22 (the `engines` field), so it runs on an older Node such as 24.15.0
even when the build step refused that version.

The npm package and the first GitHub release are not published yet, so the only
working install path is from source. Build the release files and install them
with the same scripts a published release uses.

macOS and Linux:

```sh
git clone https://github.com/yamedoff/ocbox-cli.git
cd ocbox-cli
pnpm install --frozen-lockfile
pnpm run pack:release
OCBOX_RELEASE_BASE="$PWD/dist/release" sh install.sh
```

Windows (PowerShell):

```powershell
git clone https://github.com/yamedoff/ocbox-cli.git
cd ocbox-cli
pnpm install --frozen-lockfile
pnpm run pack:release
$env:OCBOX_RELEASE_BASE = "$PWD\dist\release"
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`pnpm run pack:release` writes `ocbox-0.1.0.tgz`, `SHA256SUMS`, and `LATEST` to
`dist/release`. The install script verifies the release checksum and places
`ocbox` in `~/.ocbox` (`%LOCALAPPDATA%\ocbox` on Windows), adding the bin folder
to PATH (printing the line to add on macOS and Linux when it is not already
there).

The package is `opencloudbox@0.1.0`. It is not published to npm yet, so there is
no registry install path. `package.json` is configured for a public release
(`publishConfig.access` is `public`, with provenance) and carries no `private`
field.

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

When `opencloudbox.toml` is absent, `init` looks for a hosted project whose name
is the current folder's name. If one exists it does not create a second
project; it prints `Using existing project prj_... ("hello-box"), matched by
name; run ocbox project create to make a new one` and saves that ID in
`opencloudbox.toml`. If the file already exists, `init` prints `Validated
opencloudbox.toml` instead. To start a separate project, create one with
`ocbox project create` and select it with `--project`, or initialize from a
folder with a different name.

### 4. Start the box

```sh
ocbox start
```

```text
* session=3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b state=active project=prj_7f3c2a1b9d provider=running raw=running
Next: ocbox sync push
```

`start` creates a box for the project, or resumes the selected one when it is
paused or stopped. The `Next:` line points at the source push the new box is
waiting for. A Session in `error` cannot be started; see
[If a Session is in error](#if-a-session-is-in-error).

### 5. Push the source

```sh
printf 'hello from the box\n' > hello.txt
ocbox sync push
```

```text
Source synced: 1 addition(s), 0 modification(s), 0 deletion(s); 1 file(s) changed, 19 bytes; uploaded 1 blob(s), 19 bytes.
hello.txt
```

Dependency and build folders such as `node_modules` are left out on purpose.
The push names them (`Left out: node_modules (dependencies)`), says
`Dependencies are not uploaded; install them on the box.`, and, when a root
lockfile is pushed, ends with the install step for the box (`Next: ocbox exec --
npm ci` for npm).

### 6. Run a command and read its output

Run a program with `--` and an argument vector:

```sh
ocbox exec --timeout-seconds 60 -- cat hello.txt
```

```text
execution exe_9d6b3eb74aae3741801b93a37e4ff2 accepted
hello from the box
```

`--timeout-seconds 60` bounds the run at 60 seconds. Tokens after `--` are passed
to the program unchanged; the CLI never evaluates them in a shell. After a
disconnect, the execution ID lets you check the run with
`ocbox execution get <id>`.

Hosted commands run in the box's workspace folder, where `sync push` put the
files. Ask the box where that folder is:

```sh
ocbox exec -- pwd
```

```text
execution exe_4c1a7e2b9f0d3a6c5e8b7d2f1a9c0b3e accepted
/home/daytona/workspace
```

On staging the workspace is `/home/daytona/workspace` and there is no
`/workspace` directory, so write only inside the folder `pwd` prints.

For a shell pipeline or redirect, run `sh -c` explicitly and quote the whole
command:

```sh
ocbox exec -- sh -c 'printf "one\ntwo\n" | grep two > picked.txt'
ocbox exec -- cat picked.txt
```

The second command prints `two`. On Windows, complex `sh -c` quoting is often
lost before it reaches the box (`Syntax error: end of file unexpected`). Write
the commands to a script file, push it, and run the script instead. Put this in
a local `run-on-box.sh`:

```sh
printf "one\ntwo\n" | grep two > picked.txt
```

Then push and run it:

```sh
ocbox sync push
ocbox exec -- sh run-on-box.sh
```

`sh` reads the file, so the script needs no executable bit.

### 7. Read stored logs

```sh
ocbox logs exe_9d6b3eb74aae3741801b93a37e4ff2
```

```text
hello from the box
```

`logs` reads stored stdout and stderr only after the execution finishes, so an
agent that lost the live stream still sees the run's output. While an execution
is `pending` or `running`, `logs` is refused with its state; use
`ocbox execution get <id>` to read the execution record while it runs, then run
`ocbox logs <id>` once it is terminal.

### 8. Pull a change back from the box

`sync pull` copies changes made in the box's workspace back to the local project:

```sh
ocbox exec -- sh -c 'printf "from the box\n" >> hello.txt'
ocbox sync pull
```

```text
Source pulled: 0 addition(s), 1 modification(s); wrote 1 file(s), 32 bytes, removed 0 path(s).
hello.txt
```

Pulling over a local file you changed since the last sync is a conflict. Keep
the local copy with `--keep-local`, or replace it with the box copy with
`--overwrite-local`; deletions require `--delete` and confirmation (or `--yes`).

### 9. Save and restore a snapshot

A snapshot is a point-in-time copy of the Session. Take one, list the ones the
box keeps, restore one, and delete one:

```sh
ocbox snapshot save
ocbox snapshot list
ocbox snapshot restore <snapshot-id>
ocbox snapshot delete <snapshot-id>
```

`snapshot save` waits for the hosted Operation and prints
`Snapshot saved (operation <operation-id>)`; `--no-wait` prints `Snapshot
creation accepted (operation <operation-id>)` and returns. `snapshot list`
prints `No snapshots` or one line per snapshot (`<snapshot-id>  <createdAt>
[ <size>]`; the size is omitted when the service does not know it). Every
snapshot command defaults to the selected Session; pass a tracked Session ID or
a hosted `ses_...` ID as `<box>`. A Sandbox ID is refused (run `ocbox ls` to copy a Session ID). A box
that cannot take snapshots says `snapshot_unsupported`; at the limit it says
`snapshot_limit_reached` and tells you to delete one with
`ocbox snapshot delete` first.

### 10. Stop the box

```sh
ocbox stop
```

```text
* session=3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b state=stopped project=prj_7f3c2a1b9d provider=stopped raw=stopped
```

Stopping keeps the box's filesystem. Start it again with `ocbox start`.

### 11. Destroy the box

```sh
ocbox destroy --yes
```

```text
  session=3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b state=destroyed project=prj_7f3c2a1b9d provider=unbound raw=unbound
```

Destroying discards the box and its filesystem. To start a fresh box, run
`ocbox start` again.

## What the box has

The staging box image provides Node.js 24.20.0 and Python 3.14.6. Print them
from the box before relying on them:

```sh
ocbox exec -- node --version
ocbox exec -- python3 --version
```

```text
execution exe_... accepted
v24.20.0
execution exe_... accepted
Python 3.14.6
```

Check any other tool the same way, for example
`ocbox exec -- sh -c 'command -v <tool>'`.

## Exit codes

`ocbox exec` passes a remote program's own exit code through unchanged. The CLI
uses its own codes around that program:

| Result                                                                                                 |      Exit code |
| ------------------------------------------------------------------------------------------------------ | -------------: |
| Remote program exited                                                                                  | its 0–255 code |
| `--timeout-seconds` elapsed                                                                            |            124 |
| The CLI could not start or stream the run (missing or inactive Session, provider or transport failure) |            125 |
| Interrupted before a terminal result                                                                   |            130 |

Exit 125 is the CLI's own infrastructure-failure code, not the program's. A
remote program may itself exit 125; `--json` and `--jsonl` carry the `outcome`
discriminator (`remote_result` versus `infrastructure_error`) so automation can
tell them apart. The same applies to 124 and 130: a remote program may return
those codes, and `--json` reports `remote_result` rather than `timeout` or
`cancelled`. A malformed Session ID is a usage error and exits 1. Other commands
report a refusal with `Reason <code>.` and exit 1.

## If a Session is in error

`ocbox start` does not resume a Session whose state is `error`. It refuses with
a message like:

```text
Session <id> is in state error; run `ocbox start --new` to create a new Session, or `ocbox destroy --yes` to remove it.
```

Choose one:

```sh
ocbox start --new
# or remove the errored Session first, then start a fresh one
ocbox destroy --yes
ocbox start
```

`ocbox start --new` always creates and selects a new Session. `ocbox destroy
--yes` removes the errored Session; the next `ocbox start` creates a fresh box.
Stopping and starting a healthy Session is still `ocbox stop` then `ocbox start`.

## Sync to a hosted sandbox

After `ocbox init` and `ocbox start`, upload your current project before running it:

```sh
ocbox sync push
ocbox exec -- cat a.txt
ocbox sync push --exclude 'fixtures/**' --exclude large.bin
```

Hosted push uses the selected sandbox's persisted session mapping and the
content-addressed v2 sync API, with the v3 fast apply when the server supports
it. The server delivers the files into the box's workspace folder, and hosted
commands run from that folder; `ocbox exec -- pwd` prints it. On staging it is
`/home/daytona/workspace`, and `/workspace` does not exist there. Push reports
uploaded paths and file bytes, and an unchanged push sends no blobs. The retired
archive and manifest/chunk upload route is no longer used.

The workspace contains a hidden `.ocb-cas-owned.json` that belongs to the box's
content-addressed source sync. Leave it alone: do not edit, delete, or commit
it. The CLI excludes it from every push, and a pushed manifest may not name that
path.

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

- Node.js `24.20.0` (source build and validation; the installed CLI accepts Node.js >=22)
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

The package is named `opencloudbox` at version `0.1.0`; see
[Install](#install) for its publication state and the only working install path.
Both `ocbox` and `opencloudbox` resolve to the same built entrypoint.

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

# Sync engine

`ocbox sync` is the manifest-based source transport for a Session workspace. It
compares the local source root, the provider/fake workspace, and the last
verified baseline, then applies one-way changes through a staged, checksummed,
journaled transfer. The engine favors refusal and recovery over accidental data
loss; there is no force/replace bypass in v0.1.

## CLI usage

```sh
ocbox sync diff  [--session SESSION_ID] [--local-dir PATH] [--remote-dir PATH]
ocbox sync push  [--session SESSION_ID] [--delete] [--yes]
ocbox sync pull  [--session SESSION_ID] [--delete] [--yes]
ocbox sync recover [--session SESSION_ID]
```

`diff` is always non-mutating. `push` copies local-only changes into the Session
workspace; `pull` copies workspace-only changes into the local root. `recover`
resolves a previously interrupted transfer without ever promoting staged data.

The Session is resolved through the T4/T5 lifecycle service, so `--session`
selects an explicit Session and otherwise the selected Session is used. Missing
or unknown Sessions fail with `ENVIRONMENT_NOT_FOUND`; a Session is never
created or replaced implicitly. `--local-dir` defaults to the current directory.
`--remote-dir` (or `OCBOX_SYNC_REMOTE_DIR`) selects the concrete provider/fake
workspace; when omitted it defaults to a per-Session location under the host
state directory. `--exclude`/`--include` add repeatable user rules.

## Manifest, path, and secret policy

The scanner walks without following links, hashes through an opened file handle,
and bounds all transferable data before a transfer begins. Manifests are
canonical JSONL sorted bytewise by normalized NFC POSIX path and carry type,
size, SHA-256, mtime hint, mode, link target, and exclusion reason. Absolute,
drive, UNC, traversal, NUL/control, NTFS-stream, reserved-name, trailing
dot/space, case-colliding, and Unicode-normalization-colliding paths fail
closed. Symlinks are rejected and reported, never dereferenced.

Built-in exclusions (`.git`, dependency/build caches, `.env*`, key material,
cloud/credential stores, browser/OS stores) are evaluated before user rules and
cannot be weakened by `--include`. Excluded names are reported by `diff` but are
never transferred. Provisional caps are 1 GiB total, 100k files, 100k
directories, and 256 MiB per file.

Excluded material already present on the target side is not planner-visible, so
it is also excluded from deletion gates. The transfer therefore carries it into
the staged root before an atomic swap: a push or pull can only delete entries
the planner can see, and target-side secrets, caches, or VCS metadata survive
an apply unchanged. Carry-over re-validates every path inside the target root
at transfer time and fails closed (`SYNC_CONFLICT`) without mutating anything
if a path races away, becomes a link, or would escape the target root.

## Three-way planning and conflicts

`diff`, `push`, and `pull` compare local, remote, and the last verified baseline.
With no baseline, `push` is allowed only when the remote workspace is empty and
`pull` only when the local target is empty. Both-side changes, delete/modify,
ambiguous renames, target changes, and unverified baselines produce
`SYNC_CONFLICT`. On a conflict the target is left untouched and both copies are
preserved.

Destructive deletions require `--delete`. When the plan contains deletions and
`--delete` is absent, the command refuses before mutating. With `--delete`,
interactive use asks for confirmation; structured (`--json`/`--jsonl`) or
otherwise noninteractive use requires the explicit `--yes` acknowledgement.
There is deliberately no `--force` or `--replace` option.

## Staging, atomic apply, and recovery

A verified plan stages the desired snapshot through the provider-neutral
`TransferAdapter`. The transport decodes the authenticated archive, verifies
each entry's checksum, then atomically swaps the target where supported;
otherwise it journals every step. A crash or failed commit leaves a journal and
sets `sync_recovery_required`; subsequent `diff`, `push`, and `pull` fail closed
with `SYNC_FAILED` until `ocbox sync recover` restores the preserved target. A
corrupt journal or an ambiguous backup is never auto-resolved.

`ocbox sync recover` inspects **both** the remote and local target journals,
because a push journals against the remote workspace and a pull journals against
the local root, and resolves every recovery-required target it finds. Staged
content is never promoted implicitly.

The verified baseline is written in two phases so a crash between the target
commit and baseline persistence cannot silently produce a divergent or
permanently conflicted state. Before mutating the target, the command persists a
`pending-baseline.json` intent; only after the commit succeeds is it promoted to
`baseline.json`. If the process dies in between, the next `push`/`pull`/`recover`
proves the target either matches the intent (promote the baseline) or does not
(the commit never landed, so discard the intent and keep the prior baseline).
Baselines store only relative paths and hashes: never source content, absolute
host paths, or excluded secret names.

Sync mutations for a Session are serialized through a cross-process lock, so
concurrent writes cannot race the transfer journal or the baseline. Contention
fails closed with `OPERATION_CONFLICT` rather than waiting indefinitely.

## Output and exit policy

Human output lists additions, modifications, deletions, renames, conflicts,
blocked paths, and excluded names deterministically. `--json`/`--jsonl` emit the
single stable envelope (`schemaVersion`, `kind`, `name`, `timestamp`, `data`)
through the centralized redaction pass, so no source bytes or host paths leak.
Diagnostics and errors always go to stderr; stdout carries exactly the result
envelope (or nothing on failure). Conflicts, blocked/colliding paths,
size/count limits, malformed archives, target mismatches, recovery-required
state, and unapproved deletions all exit non-zero with an `OcboxError` code
(`SYNC_CONFLICT`, `SYNC_TOO_LARGE`, `SYNC_INTEGRITY`, `SYNC_FAILED`); concurrent
mutation yields `OPERATION_CONFLICT` and a malformed ignore pattern yields
`CONFIG_INVALID`.

## Fake transport scope and evidence

The v0.1 CLI drives the repository's concrete local/fake transfer target
(`LocalTransferAdapter`) selected through a provider seam, so the built CLI can be
exercised end to end without a paid dependency. It is a contract/integration
fixture, not proof of sandbox isolation. T8 is expected to register real
provider adapters behind the same `TransferAdapter`/`ProviderSource` boundary:
real provider transport, remote workspace layout, and continuous sync remain out
of scope.

The test matrix covers command registration/help, Session target resolution,
first sync, idempotent re-push, `diff`, `push`, `pull`, both-side conflicts,
delete refusal/non-TTY refusal/`--yes` acknowledgement, interactive confirmation,
JSON envelope purity (one envelope on stdout, clean stderr, typed failures),
recovery-required fail-closed behavior, the target-commit/baseline-persistence
crash boundary, concurrent-lock refusal, malformed ignore patterns, binary round
trips, and built-in exclusions.

## Content-addressed hosted push (v2)

For a hosted `sesdo_` Session, `sync push` uses the v2 plan/apply API. The CLI
resolves that ID through the owned sandbox mapping; local Session IDs do not
select the protocol. Older hosted Sessions retain their archive transport.

The same scanner, `.gitignore`, `.opencloudboxignore`, `--exclude`/`--include`
precedence and built-in exclusions apply. `.git`, `node_modules`, caches,
secret files, the local state subtree and sync bookkeeping never transfer.
Links and unsafe/colliding paths are refused. Limits are 100,000 entries,
256 MiB per file and 1 GiB total content. Files retain executable/nonexecutable
modes (0755/0644); empty files and directories are represented explicitly.

Initial small files share deterministic bundles up to 8 MiB. Larger files use
parts up to 16 MiB. Later pushes preserve unchanged bundle slices; up to 512
dirty small files use individual blobs, so three small edits need at most three
uploads. Manifest pages contain up to 512 entries and 512 KiB, with at most
512 pages, 4,096 blobs and 32 MiB metadata. Only blobs requested by the plan
are uploaded, with four concurrent PUTs and at most three attempts each.
The returned upload URLs are opaque capabilities: the CLI never attaches its
API bearer, follows redirects, logs them or saves them to disk.

The CLI commits by replaying the same apply request every second until a
matching terminal receipt, within a 15-minute deadline. Upload attempts have a
120-second timeout. Control requests use the normal authenticated transport
and up to three attempts on retryable errors. Success is reported only after
apply succeeds. A server refusal emits a safe typed error and exits 1; an
interrupt emits `OPERATION_CANCELLED` and exits 1. Rerun the same push to resume.

Unsigned metadata and cached source blobs live under
`<state-dir>/sync/<project>/<local-session>/cas/<scope>/`. The scope binds the
API, hosted Session and absolute local root without storing that root in
metadata. Files are hashed again on every push; cached bytes are verified before
reuse or upload. An interrupted manifest keeps its identity only if current
pages match and its local checkpoint is less than 45 minutes old. Changed source
gets a fresh identity. Terminal plan failures discard the pending identity.
State contains relative paths, sizes, modes and hashes; the blob cache contains
source content and should be protected like the workspace itself.

The v2 contract mirrors paths owned by the previous sync and keeps other
workspace files. Removal of paths recorded in this workspace's last successful
state requires `--delete` and confirmation, or `--delete --yes` in noninteractive
use. The local state is not a proof of remote tree contents or a cross-machine
conflict detector. Hosted `pull`, `diff` and `recover` remain unsupported.

Human TTY output shows phase/upload progress. `--json` keeps one result envelope;
`--jsonl` adds `sync.progress` events (`phase`, optional file/page counts and
uploaded blob/byte counts) followed by `sync.pushed`. The v2 result adds
`protocolVersion: 2`, `uploadedBlobs`, `uploadedBytes` and the applied plan ID
in `operationId`. Counts describe this invocation, including when resuming.

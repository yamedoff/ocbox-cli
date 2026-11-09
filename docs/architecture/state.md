# CLI local state and protected credentials

## What it does

State is an area inside the CLI application, not a separate network service. LifecycleStore (on top of AtomicJsonStore) tracks the selected Session, Sessions, Sandboxes and Operations for the working folder; CredentialStore isolates bearer material. LocalStateStore is a similar per-project store exported for embedding; no command in this repository calls it. Separate locks keep concurrent processes from corrupting file state or reusing rotating credentials.

## Inside

Local records validate their schema and project identity before use. Atomic replacement writes a completed file before changing the visible destination. ExclusiveFileLock uses ownership evidence and bounded stale-lock recovery. Auth uses an outer auth.state.lock and inner store locks in a fixed order.

Hosted lifecycle state is selected by the token subject: the first command reads `/auth/me`, caches the subject in auth.json and uses a hash-named account directory. A server without the endpoint or an offline token keeps the legacy shared directory. HostedOAuthCredentialStore selects an available OS adapter or protected-file fallback before an operation. The default runtime wires the fallback. POSIX protection and Windows ACL verification enforce user-only access; an unsafe path or unprovable protection fails rather than returning usable credentials.

## Data it keeps

Configuration/state: selected Session, local-to-hosted mappings and pending operations (`accounts/<subject-hash>/lifecycle/<project>.json` for a hosted login, `lifecycle/<project>.json` when no subject is known), operation checkpoints (`ocbox-operation-checkpoints.json`), sync baselines (`sync/<project>/<session>/`), fake-provider state (`providers/fake.json`) and Codex manifests (`agents/codex/`). A hosted mapping may retain both the CLI execution ID printed by `exec` and the hosted ID used on the wire. Secret store: access/refresh material. Auth metadata contains only identity/binding/expiry facts, including the cached `/auth/me` subject.

V2 sync stores unsigned pending/success pages and source blobs under `sync/<project>/<session>/cas/<scope-hash>/`, bound to API/hosted Session/local root. Capability URLs are never persisted, and the state subtree is excluded before scanning. Its writers request 0600 files and 0700 directories but do not use the credential store's Windows ACL verification or the AtomicJsonStore fsync protocol. None of these is a copy of the server database.

## States

For lifecycle/auth JSON: unlocked → lock acquired → validated read/update → atomic replacement → lock released. CAS writes occur under the Session sync lock, using their separate rename-based writer. Auth generations rotate under the shared gate. Corrupt/unsafe records are refused or quarantined according to the store; they are not silently treated as an empty valid project.

## Limits and config

State-directory flags/environment choose where machine state lives. Credential storage has its own platform directory. Lock waits are bounded and cancellable. Credential schemas bound token strings and validate account/provider identity before selecting the store.

## When it fails

Lock conflict, cancellation, schema corruption, stale generation and protection failure have typed errors. Logout/rollback report failed cleanup. The deprecated Local state map record preserves earlier human notes while active code entries point to the CLI state area.

## Code evidence

Atomic JSON/locks: `src/lifecycle/atomic-json-store.ts:56–182`, `src/state/exclusive-file-lock.ts:45–238`. Credential protection: `src/credentials/protected-file.ts:70–179`; hosted mapping scope: `src/providers/ocbox/factory.ts:24–105`; account directory selection: `src/cli/runtime.ts:170–218`, `src/auth/identity.ts:8–41`; CAS state: `src/sync/cas-push.ts:87–120`, `cas-snapshot.ts:37–81`.

Verified against ocbox-cli @ b604910 plus the subject-scoped lifecycle directory.

A hosted mapping retains the CLI execution ID next to the hosted ID so `cancel` reports the same ID `exec` printed.

Verified against ocbox-cli @ 872e6f2 plus the execution-ID mapping change.

# CLI local state and protected credentials

## What it does
State is an area inside the CLI application, not a separate network service. LifecycleStore (on top of AtomicJsonStore) tracks the selected Session, Sessions, Sandboxes and Operations for the working folder; CredentialStore isolates bearer material. LocalStateStore is a similar per-project store exported for embedding; no command in this repository calls it. Separate locks keep concurrent processes from corrupting file state or reusing rotating credentials.

## Inside
Local records validate their schema and project identity before use. Atomic replacement writes a completed file before changing the visible destination. ExclusiveFileLock uses ownership evidence and bounded stale-lock recovery. Auth uses an outer auth.state.lock and inner store locks in a fixed order.

HostedOAuthCredentialStore selects an available OS adapter or protected-file fallback before an operation. The default runtime wires the fallback. POSIX protection and Windows ACL verification enforce user-only access; an unsafe path or unprovable protection fails rather than returning usable credentials.

## Data it keeps
Configuration/state: selected Session, local-to-hosted mappings and pending operations (lifecycle/<project>.json), operation checkpoints (ocbox-operation-checkpoints.json), sync baselines (sync/<project>/<session>/), fake-provider state (providers/fake.json) and agent manifests (agents/codex/). Secret store: access/refresh material. Auth metadata contains only identity/binding/expiry facts. None of these is a copy of the server database.

## States
Unlocked → lock acquired → validated read/update → atomic replacement → lock released. Auth generations rotate under the shared gate. Corrupt/unsafe records are refused or quarantined according to the store; they are not silently treated as an empty valid project.

## Limits and config
State-directory flags/environment choose where machine state lives. Credential storage has its own platform directory. Lock waits are bounded and cancellable. Credential schemas bound token strings and validate account/provider identity before selecting the store.

## When it fails
Lock conflict, cancellation, schema corruption, stale generation and protection failure have typed errors. Logout/rollback report failed cleanup. The deprecated Local state map record preserves earlier human notes while active code entries point to the CLI state area.

Verified against ocbox-cli @ 21f12a95ae49f7a343c17576a5aea1cb6c36f659

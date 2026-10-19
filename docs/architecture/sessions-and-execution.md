# CLI Sessions and hosted command execution

## What it does
LifecycleService maintains local Session views and operations. OcboxSandboxProvider maps local IDs to hosted Session IDs and implements the public API contract. ExecutionService validates a provider target and consumes its event/result handle. The hosted adapter calls the API directly; the fake adapter starts the local helper process.

## Inside
Start reuses a suitable selected Session or records an intent before createSession. The provider keeps the returned operation and observes completion. Start/resume, stop and destroy use idempotency keys and then reconcile the hosted Session. Destroy confirms a deleted hosted Session before marking the local mapping deleted; history remains in the lifecycle file.

Explicit shell mode rejects a known non-Linux effective OS. When the hosted effective specification is incomplete, the adapter keeps it unobserved and the remote executor decides shell compatibility; the requested spec is never promoted to observed metadata.

Execution submits createExecution, retains its handle and observes event/result endpoints. collectExecutionEvents polls event pages, orders by sequence, skips duplicates and exposes an optional cursor-checkpoint callback; the provider keeps its cursor in memory. Repeated retryable page failures fall back to Execution/result polling. The fake provider's helper emits framed events. The command's nonzero exit is separate from infrastructure failure.

Hosted argv is shell-quoted into the public command string; shell mode sends its string directly. The adapter rounds timeouts up to seconds within 1–3600. Its createExecution body currently sends command and timeout only, so parsed cwd/environment values are not transmitted by this adapter.

## Data it keeps
Local Session state, selection, local-to-hosted mappings, pending operations and operation checkpoints. Hosted Execution and sandbox observations arrive through the public API. No server vendor identity is needed by this adapter.

## States
Local create/mutation intent → dispatched → observed terminal result → reconciled Session view. Execution pending/running → command success/failure or cancellation. An elapsed client deadline does not prove the server effect was undone. Destroy marks the hosted mapping deleted and retains local Session/Operation history with released bindings.

## Limits and config
Operation wait defaults to 5 minutes. Event collection defaults to a 5-minute wait, 250 ms polling and event pages of 100; its stream-failure bound defaults to 3. Legacy source-apply healthy polling is 1 second. The event collector falls back after more than three consecutive retryable page failures; non-retryable failures propagate immediately. Retry policy and Retry-After are applied within the remaining deadline.

## When it fails
Unsupported capabilities fail before pretending to perform an action. The hosted adapter advertises supportsMemoryPause=false, so CLI pause refuses before dispatch, even though a direct provider pause method exists. Preview methods exist in the provider but are subject to capability checks; a method's presence is not live deployment evidence. Lost replies preserve recovery evidence. Cancellation requires a terminal observation or reports incomplete convergence.

Execution failures after an accepted start use the same safe typed code/message as failures before start. Human output prints the safe message; JSON and JSONL include the existing optional error detail. Infrastructure failure still exits 125 and remains distinct from a command whose own exit code is 125. Unknown error causes keep the generic envelope and are not serialized. This applies when event/result collection surfaces an error. The existing fallback separately tries to drain remaining events on a best-effort basis, so a terminal result does not prove all output history was recovered.

## Code evidence
Selection and transitions: `src/lifecycle/service.ts:84–370,410–627`. Hosted lifecycle/exec/preview: `src/providers/ocbox/provider.ts:507–925,1033–1395`. Output collection: `src/providers/ocbox/executions.ts:104–434`; cancellation helper: `src/providers/ocbox/operations.ts:399–486`.

Verified against ocbox-cli @ d949442bca48a5e84b7f0a26c51a1f83b07bd202

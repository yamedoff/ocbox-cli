# CLI Sessions and hosted command execution

## What it does
LifecycleService maintains local Session views and operations. OcboxSandboxProvider maps local IDs to hosted Session IDs and implements the public API contract. ExecutionService starts a helper process which returns events and a terminal result; it does not execute hosted commands in the developer's shell.

## Inside
Start reuses a suitable selected Session or records an intent before createSession. The provider keeps the returned operation and observes completion. Start/resume, stop and destroy use idempotency keys and then reconcile the hosted Session. Destroy confirms absence before dropping a local mapping.

Execution submits createExecution, retains its handle and observes event/result endpoints. collectExecutionEvents orders by sequence, skips duplicates, checkpoints the cursor and can fall back from streaming to polling. The helper emits framed events and coordinates interrupt/timeout with cancellation. The command's nonzero exit is separate from infrastructure failure.

## Data it keeps
Local Session state, selection, local-to-hosted mappings, pending operations and execution checkpoints. The hosted API owns command journals and actual sandbox state. No server vendor identity is needed by this adapter.

## States
Local create/mutation intent → dispatched → observed terminal result → reconciled Session view. Execution pending/running → command success/failure or cancellation. An elapsed client deadline does not prove the server effect was undone.

## Limits and config
Operation wait defaults to 5 minutes. Event collection defaults to a 5-minute wait, 250 ms polling and event pages of 100; its stream-failure bound defaults to 3. Source-apply healthy polling is 1 second. Retry policy and Retry-After are applied within the remaining deadline.

## When it fails
Unsupported capabilities fail before pretending to perform an action. The client has a pause method, but the managed staging serving-capability list does not expose pauseSession. Preview methods exist in the provider but are subject to capability checks; a method's presence is not live deployment evidence. Lost replies preserve recovery evidence. Cancellation requires a terminal observation or reports incomplete convergence.

Verified against ocbox-cli @ 4a917c828da6

# CLI Sessions and hosted command execution

## What it does
LifecycleService maintains local Session views and operations. OcboxSandboxProvider maps local IDs to hosted Session IDs and implements the public API contract. ExecutionService starts a helper process which returns events and a terminal result; it does not execute hosted commands in the developer's shell.

## Inside
Start reuses a suitable selected Session or records an intent before createSession. The provider keeps the returned operation and observes completion. Start/resume, stop and destroy use idempotency keys and then reconcile the hosted Session. Destroy confirms absence before dropping a local mapping.

Execution submits createExecution, retains its handle and observes event/result endpoints. collectExecutionEvents orders by sequence, skips duplicates, checkpoints the cursor and can fall back from event-page collection to state/result polling. The helper emits framed events and coordinates interrupt/timeout with cancellation. The command's nonzero exit is separate from infrastructure failure.

## Data it keeps
Local Session state, selection, local-to-hosted mappings, pending operations and execution checkpoints. The hosted API owns command journals and actual sandbox state. No server vendor identity is needed by this adapter.

## States
Local create/mutation intent → dispatched → observed terminal result → reconciled Session view. Execution pending/running → command success/failure or cancellation. An elapsed client deadline does not prove the server effect was undone.

## Limits and config
Operation wait defaults to 5 minutes. Event collection defaults to a 5-minute wait, 250 ms polling and event pages of 100; its stream-failure bound defaults to 3. Source-apply healthy polling is 1 second. Retry policy and Retry-After are applied within the remaining deadline.

## When it fails
Unsupported capabilities fail before pretending to perform an action. The client has a pause method, but the client capability contract must permit pauseSession before dispatch. Preview methods exist in the provider but are subject to capability checks; a method's presence is not live deployment evidence. Lost replies preserve recovery evidence. Cancellation requires a terminal observation or reports incomplete convergence.


## Observation and local authority
`src/providers/ocbox/executions.ts:104-434` collects buffered event pages, not an SSE connection. It resets invalid cursors, orders sequence, checkpoints and falls back only after failures exceed the default 3. The split page/ingest/drain/read helpers preserve the original deadline. `src/lifecycle/service.ts:266-273` lists local Sessions without remote enumeration; status observes a saved mapping and use only changes local selection.


## Source responsibilities

These source definitions are the navigation index for the responsibilities above. Line ranges refer to the verified source snapshot.

| Responsibility | Source |
| --- | --- |
| LifecycleStore | `src/lifecycle/store.ts:11-33` |
| LifecycleService | `src/lifecycle/service.ts:84-111` |
| OcboxSandboxProvider.create | `src/providers/ocbox/provider.ts:473-474` |
| OcboxSandboxProvider.#execute | `src/providers/ocbox/provider.ts:1072-1199` |
| runExecutionCommand | `src/execution/command-runner.ts:229-238` |
| uploadPreparedSource | `src/providers/ocbox/source.ts:131-348` |
| DEFAULT_API_URL | `src/providers/ocbox/defaults.ts:2-2` |
| waitForHostedOperation | `src/providers/ocbox/operations.ts:201-391` |
| collectExecutionEvents.pollFallback | `src/providers/ocbox/executions.ts:343-364` |
| OcboxSandboxProvider.#mutate | `src/providers/ocbox/provider.ts:798-901` |
| OcboxSandboxProvider.cancelSandboxExecution | `src/providers/ocbox/provider.ts:1009-1070` |
| LifecycleService.status | `src/lifecycle/service.ts:138-155` |
| LifecycleService.list | `src/lifecycle/service.ts:266-273` |
| LifecycleService.use | `src/lifecycle/service.ts:129-136` |
| runExecutionHelper | `src/execution/helper-runtime.ts:84-242` |
| mapApiFailureToOcboxError | `src/api/client/errors.ts:69-201` |
| encodeHelperEventFrame | `src/execution/helper-protocol.ts:86-95` |
| ExecutionService.start | `src/execution/service.ts:117-213` |
| createMetadataClient | `src/metadata/client.ts:83-94` |
| isTerminalOperationState | `src/providers/ocbox/wire.ts:203-205` |
| collectExecutionEvents.fetchEventPage | `src/providers/ocbox/executions.ts:259-290` |
| collectExecutionEvents.ingestPage | `src/providers/ocbox/executions.ts:292-315` |
| collectExecutionEvents.drainRemainingEvents | `src/providers/ocbox/executions.ts:323-341` |
| collectExecutionEvents.readExecution | `src/providers/ocbox/executions.ts:139-197` |
| collectExecutionEvents.readResult | `src/providers/ocbox/executions.ts:199-257` |

Verified against ocbox-cli @ 8af54e8

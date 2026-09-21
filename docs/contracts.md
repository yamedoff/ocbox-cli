# Domain and provider contracts

Import the side-effect-free contract API from `opencloudbox/contracts`. Importing this export does
not execute the CLI entrypoint.

```ts
import {
  SandboxSpecSchema,
  type OperationContext,
  type SandboxProvider,
} from 'opencloudbox/contracts'
```

## Identity and ownership

`Project`, `Session`, and `Sandbox` identifiers are separately branded even though OpenCloudBox IDs
share one runtime UUID/ULID representation. `ProviderSandboxId` is a different opaque type and must
never be substituted for an OpenCloudBox ID.

A Project retains many Sessions. A Session owns an ordered history of `SessionSandboxBinding`
records. v0.1 permits at most one active binding, and that binding must have the `primary` role. Zero
active bindings is valid only while the Session is `creating` or after provider deletion has been
verified. Historical released bindings remain in the aggregate so a later multi-sandbox release can
extend policy without changing Session identity.

## Lifecycle authority

The Session lifecycle and provider lifecycle are intentionally different state machines. Use
`SESSION_TRANSITIONS` and `assertSessionTransition` for product state. Store provider observations
with the normalized state, unchanged raw state, desired state, reason, observation time, and
lifecycle timestamps. An unknown raw state normalizes to `unknown`; it is never discarded.

| Action | Processes | RAM | Filesystem |
| --- | --- | --- | --- |
| `pause` | preserved | preserved | preserved |
| `stop` | terminated | discarded | preserved |
| `destroy` | terminated | discarded | discarded |

Lifecycle success requires a fresh, structurally valid provider observation whose normalized state
matches the target Session state. `SessionTransitionEvidence.transitionStartedAt` is the trusted
start of the persisted Operation or reconciliation attempt; an observation older than that fence is
rejected. The same guard applies to a transitional rollback and to `error`-state reconciliation:
callers cannot select a stable recovery state that the provider did not freshly observe. Cleanup may
enter `destroying`, but `destroyed` requires both a post-fence `deleted` observation and its provider
deletion timestamp. Unsupported behavior must be rejected through the capability preflight before
a provider mutation is invoked.

## Requested and effective specifications

`RequestedEffectiveSpec` never manufactures provider truth. `effective` and
`effectiveObservedAt` are both `null` until observation, then appear together. CPU is expressed in
millicores; RAM and disk are bytes; every lifecycle timeout is milliseconds. Environment fields
contain names and constrained non-secret locators only—`ocbox:<opaque-id>` or
`provider:<provider-name>:<opaque-id>`. Credential-shaped values remain invalid even after a valid
namespace prefix; encrypted values, suffixes, previews, and raw secret values are never accepted.

## Mutation and idempotency contract

Every mutation accepts `OperationContext`, including its pre-generated request ID, operation ID,
idempotency key, attempt number, and issuance timestamp. Create additionally declares how an adapter
must recover after an ambiguous response:

- `metadata_search_then_adopt` searches provider metadata for the Session and Operation IDs before
  creating again.
- `serialize_then_reconcile` serializes creation and reconciles provider resources before retrying
  when metadata search is unavailable.

A successful Operation records whether it created a resource, replayed a prior result, or adopted an
existing provider resource. This package defines the contract only; adapters and persistence arrive
in later tasks.

Before create, `CreateSandboxInvocationSchema` binds adoption metadata to the `OperationContext`.
After create, `CreateSandboxInvocationResultSchema` validates the combined context, request, and
result, requiring the returned Operation ID, request ID, idempotency key, action, and Session ID to
match the persisted invocation identity.

Structured command execution uses `{ mode: 'argv', argv: readonly string[] }`. Shell evaluation is a
separate explicit `{ mode: 'shell', shell: string }` variant. A remote nonzero exit is a completed
`ExecResult`, not an `OcboxError`. File payloads remain `Uint8Array` end to end.

The provider port groups execution, file, source, and preview operations behind nested interfaces.
Every mutation receives an `OperationContext`; read-only calls receive a `RequestContext`. Preview
results must be authenticated, direct inbound networking remains blocked, and provider adapters
must return only normalized contract objects rather than SDK objects.

## Error safety

`OcboxError` exposes only the stable 32-code catalogue, a human-safe message, the registry-owned
retry classification, request ID, optional safe provider code, and recursively checked redacted
details. The schema recursively rejects credential-like material, command output, raw `error` and
provider-error fields, Windows/UNC and POSIX filesystem paths, secret suffix/preview material,
stack/cause data, and recoverable secret representations while retaining explicitly safe metadata.

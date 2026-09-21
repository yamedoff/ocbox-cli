# CLI authentication

`ocbox auth` implements the public-client lane of OpenCloudBox identity. It uses
an OAuth 2.1 authorization-code flow with S256 PKCE, a loopback redirect, and
rotated bearer/refresh material stored only through the T3 credential port.
There is no static API-token launch path and no client secret.

## CLI usage

```sh
ocbox auth login --api-url https://api.example --authorize-url https://hosted/authorize [--no-browser]
ocbox auth status
ocbox auth logout
```

`--api-url` (or `OCBOX_API_URL`) is the hosted API base URL. All protocol
endpoints are derived from the pinned hosted OpenAPI contract root: the value
is normalized (a trailing `/v1` is removed first, exactly like the generated
client) and served under `/v1/auth/...`. Cleartext `http` is only accepted for
literal loopback hosts (`127.0.0.1`, `localhost`, `[::1]`), so codes, PKCE
verifiers, and token pairs never cross a non-loopback network hop in cleartext.
Programmatic token and revocation endpoint overrides must stay under the
configured API base: the pinned contract publishes no separate token/revoke
host, and those endpoints receive codes, verifiers, refresh tokens, and revoke
tokens. The browser authorization URL (`--authorize-url`) may use a separate
origin, because only public parameters (client id, redirect URI, state, PKCE
challenge) travel to the browser page. The registered public client is `ocb_cli` with the single
`source:read` scope and the `cli` audience; the authorized redirect is exactly
`http://127.0.0.1:{randomPort}/callback`.

**Browser page (T16 canonical).** The private T16 wiring (`f2aa4d4`) serves the
user-facing consent page on the same `/v1/auth/cli/authorize` path via
method/content-type dispatch (GET renders HTML, form POST carries the
approve/deny gesture, JSON POST keeps the T15 contract), outside the JSON
OpenAPI so no YAML/client drift is possible. `login` therefore defaults
`--authorize-url` (or `OCBOX_AUTHORIZE_URL`) to that canonical page under the
configured deployment base, preserving subpaths exactly like the generated
client (`{base}/v1/auth/cli/authorize`); an explicit override may still name a
separate browser origin and is validated to be an absolute, uncredentialed,
query/fragment-free http(s) (https off-loopback) endpoint. The CLI appends the
OAuth-style query (`response_type`, `client_id`, `redirect_uri`, `scope`,
`audience`, `state`, `code_challenge`, `code_challenge_method=S256`) matching
the T16 `apps/web` builder.

`login` prints/opens the authorization URL and waits for the loopback callback.
`--no-browser` forces the manual-open path, which prints the same safe
authorization URL and keeps the listener active. `status` reports only
logged-in/expiry/scope/audience facts; `logout` attempts server revocation and
always clears local material. All three support `--json`/`--jsonl` and never
emit secret values.

## Flow and listener

1. Generate a 43-character verifier, its S256 challenge, and an opaque `state`
   from the OS CSPRNG.
2. Bind an HTTP listener to `127.0.0.1` on an OS-selected port with the exact
   `/callback` path. Only `GET /callback` on the exact `127.0.0.1:{port}` Host is
   accepted; wrong method/path/host, missing/wrong/replayed state, malformed
   codes, and provider `error` responses are refused and never resolve a code.
   A callback carrying both `code` and `error` is refused as mutually
   ambiguous, and duplicated occurrences of security-relevant callback
   parameters (`code`, `state`, `error`, `iss`, `client_id`,
   `code_challenge`, `error_description`, `error_uri`) are refused, because a
   duplicated value would leave which copy governs undefined. The `state`
   comparison is timing-safe. Exactly one short-lived callback is accepted;
   the listener times out and releases the port on completion, cancellation,
   Ctrl+C, or failure.
3. Open the authorization URL with a platform process invocation that passes the
   URL as one argv item and never invokes a shell (`rundll32` on Windows, `open`
   on macOS, `xdg-open` on Linux). If opening fails, the authorization URL is
   printed for manual use while the loopback listener stays active.
4. Exchange the code with the original verifier, redirect URI, and client,
   validating the response shape before persisting.

There is deliberately no out-of-band or pasted-code fallback.

## Token lifecycle

Access material is attached only as `Authorization: Bearer`, only to the
mandatory configured API base. A foreign origin or same-origin sibling outside
a configured deployment subpath is refused before the credential is read.
Requests use manual redirect mode, applied by the auth layer so credentials are
never replayed across a 3xx. The configured base is validated like the issuer.
An idempotency key is validated against the pinned contract constraint (1-128
characters from `[A-Za-z0-9._:-]`) before it can reach the wire or justify a
retry. On a 401, rotation and the single retry occur only for replay-safe calls
(idempotent methods or a call with a contract-valid idempotency key).
Concurrent readers serialize through the state-directory lock; a waiter adopts
a fresher generation another process already rotated instead of presenting the
same refresh token. A 401-triggered rotation remains forced only while the
store holds the rejected access token. Lock waits are cancellable. A terminal
second 401 compare-deletes only the generation it used, under that same lock.
Refresh reuse or revocation clears matching local material and returns
`AUTH_REQUIRED`. OAuth protocol response reads are bounded at 64 KiB on success
and error paths; generated hosted-client response reads default to a 16 MiB
ceiling. Both reads cover streaming bodies and never echo the body. Caller
cancellation is `OPERATION_CANCELLED`; a transport deadline is
`PROVIDER_TIMEOUT`. Issuer, client, credential identity, audience, and the
exact scope set must match the machine-level metadata before the credential is
used, otherwise the client fails with `AUTH_FORBIDDEN`.

## Concurrency

Authenticated credential reads, refresh rotation, login commits, status
reconciliation, and logout all use one bounded cross-process state lock in the selected state
directory (`auth.state.lock`). This prevents a fresh read from crossing a
login/logout commit and prevents two processes from presenting one rotating
refresh token. Contention is `OPERATION_CONFLICT`; cancellation while waiting
is `OPERATION_CANCELLED`. The state lock is always outermost and each store
keeps its own internal lock, so lock acquisition has one order. Login holds the
state lock only for its state commit, not while the user is in the browser.

Local cleanup failures on logout, and a failed metadata clear on status,
surface a typed `INVALID_STATE` failure rather than a false success. If login's
rollback itself fails after a failed metadata commit, callers receive a typed
`INVALID_STATE` error because the credential and metadata generations may no
longer agree; running `ocbox auth logout` clears both stores regardless. The
metadata store reports a cleared file only after its absence has been
confirmed; transient sharing violations are retried with backoff instead of
being silently treated as success.

## Storage boundary

Bearer/refresh material lives only in the T3 `CredentialStore` (OS adapter when
available, otherwise the user-only protected file). The machine-level auth
metadata file holds only the non-secret credential reference plus issuer,
client, audience, scope, and expiry; it never contains tokens, codes, or
verifiers. Project state is not extended with secret material.

## Hosted contract

The public client/types are generated deterministically from the reviewed
private OpenAPI artifact pinned in [`openapi/PROVENANCE.json`](../openapi/PROVENANCE.json).
`pnpm run api:check` verifies the SHA-256 checksum and regenerates the client to
detect drift; it runs in CI and in `pnpm run test`.

## Hosted provider composition (T14)

The hosted data plane consumes one composed surface so login, token use, and
the generated client can never disagree:

- **One API base.** `protocolEndpointsFromIssuer` and the generated
  `createClient` normalize the base identically (a trailing `/v1` is stripped
  once, then `/v1/...` is appended per call). `createHostedApiClient` passes
  the protocol issuer through untouched, keeping the generated client's
  normalization the single URL model.
- **One state directory.** `resolveAuthStateDirectory` (explicit directory,
  then `--state-dir`/`OCBOX_STATE_DIR`, then the platform default) locates the
  `auth.json` metadata and the `auth.state.lock` for both login and
  `createHostedTokenManager`. Bearer material itself stays in the T3 platform
  credential directory, never in the state directory.
- **One credential identity.** The single CLI identity is the `hosted-oauth`
  key (`ocbox`/`default`); the machine-level metadata stores that reference
  plus issuer, client, `cli` audience, scopes, and expiry — never tokens,
  codes, or verifiers. A stored credential minted by another issuer, or for
  another audience, is refused before use.
- **One transport.** `createAuthenticatedTransport` adapts
  `AuthenticatedHttpClient` to the generated client's `ApiTransport` port:
  bearer-only `Authorization`, origin *and* base-subpath binding, manual
  redirects, bounded response bodies and timeouts, and the single serialized
  refresh-and-retry for replayable requests (idempotent methods or calls
  carrying an `Idempotency-Key`). Per-operation keys flow through from the generated
  client; `AbortSignal`s propagate; `ApiResult` request IDs and replay flags
  surface per call. HTTP/auth error-to-catalogue mapping stays with the hosted
  provider layer.
- **One output contract.** Auth commands emit facts only
  (logged-in/expiry/scopes/audience) through the shared JSON/JSONL/human
  envelopes; secret values never reach stdout, stderr, diagnostics, fixtures,
  or project state.

## Integration gate

The non-production host integration (a real browser completing login against a
real hosted server) remains explicitly blocked here. Automated coverage uses
mocked browser/HTTP/listener/clock/entropy/credential boundaries plus a
Windows/Linux CLI subprocess smoke with a local mock server and no real browser,
network, or account.

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
The registered public client is `ocb_cli` with the single `source:read` scope
and the `cli` audience; the authorized redirect is exactly
`http://127.0.0.1:{randomPort}/callback`.

**Integration blocker (fail closed).** The pinned hosted contract (`/v1`,
private commit `96ea2292…`) publishes `/auth/cli/authorize` only as an
*authenticated POST* web-consent route and does not yet expose a browser-facing
GET authorization page that the CLI could open. `login` therefore *requires* an
explicit `--authorize-url` (or `OCBOX_AUTHORIZE_URL`) naming the hosted
browser authorization URL, validated to be an absolute, uncredentialed,
query/fragment-free http(s) (https off-loopback) endpoint. No default page is
derived — the protocol-only endpoint factory (`protocolEndpointsFromIssuer`)
carries no browser URL at all, so an unopenable URL is unrepresentable. The
canonical page and its query contract must land with the T16 web wiring before
a default can exist; until then the OAuth-style query the CLI appends
(`response_type`, `client_id`, `redirect_uri`, `scope`, `audience`, `state`,
`code_challenge`) is a provisional CLI-side shape the T16 page must confirm,
and the CLI never pretends the API POST route is a browser page.

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
   The `state` comparison is timing-safe. Exactly one short-lived callback is
   accepted; the listener times out and releases the port on completion,
   cancellation, or failure.
3. Open the authorization URL with a platform process invocation that passes the
   URL as one argv item and never invokes a shell (`rundll32` on Windows, `open`
   on macOS, `xdg-open` on Linux). If opening fails, the authorization URL is
   printed for manual use while the loopback listener stays active.
4. Exchange the code with the original verifier, redirect URI, and client,
   validating the response shape before persisting.

There is deliberately no out-of-band or pasted-code fallback.

## Token lifecycle

Access material is attached only as `Authorization: Bearer`, only to the
configured API origin (any other absolute URL is refused before the credential
is even read), and never across redirects: requests run with manual redirect
mode and any 3xx is an opaque failure. Expiry skew is enforced before use. On a
401, rotation and the single retry are justified only when the request is
replay-safe (idempotent/safe methods, or any method carrying a contract
idempotency key); POST/PATCH without a key is surfaced as-is without burning a
refresh family. Concurrent readers collapse into one serialized refresh —
in-process and across separate CLI processes through the state-directory file
lock — and a terminal second 401 clears local material only when no concurrent
actor already stored newer material. Refresh reuse or revocation clears local
material and returns a typed login-required error (`AUTH_REQUIRED`). Requests
are bounded by a timeout and expose the server request ID and `Retry-After`
hints. Issuer, audience, client, and required scopes are bound before a
credential is used: the machine-level metadata must attest that the stored
credential was minted by the configured issuer, or use fails with `AUTH_FORBIDDEN`.

## Concurrency

Refresh rotation runs inside a bounded cross-process lock on the state
directory (`auth.refresh.lock`), so two `ocbox` processes never present the
same rotating refresh token simultaneously; contention surfaces as
`OPERATION_CONFLICT` instead of an unbounded stall. Status and logout do not
take that lock. Local cleanup failures on logout surface a typed
`INVALID_STATE` failure rather than a false success, and login restores the
exact prior credential/metadata state if its own commit fails in a way that
cannot be rolled back cleanly.

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
  `auth.json` metadata and the `auth.refresh.lock` for both login and
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
  redirects, bounded timeouts, and the single serialized refresh-and-retry for
  replayable requests (idempotent methods or calls carrying an
  `Idempotency-Key`). Per-operation keys flow through from the generated
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

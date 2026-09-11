# CLI authentication

`ocbox auth` implements the public-client lane of OpenCloudBox identity. It uses
an OAuth 2.1 authorization-code flow with S256 PKCE, a loopback redirect, and
rotated bearer/refresh material stored only through the T3 credential port.
There is no static API-token launch path and no client secret.

## CLI usage

```sh
ocbox auth login  --api-url https://api.example [--no-browser] [--authorize-url URL]
ocbox auth status
ocbox auth logout
```

`--api-url` (or `OCBOX_API_URL`) is the hosted API base URL. The registered
public client is `ocb_cli` with the single `source:read` scope and the `cli`
audience; the authorized redirect is exactly
`http://127.0.0.1:{randomPort}/callback`.

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

Access material is attached only as `Authorization: Bearer`. Expiry skew is
enforced before use. On one eligible `401`, concurrent requests collapse into a
single serialized refresh, the rotated material is stored atomically, and only
an idempotent/safe request is retried once. Refresh reuse or revocation clears
local material and returns a typed login-required error (`AUTH_REQUIRED`).
Requests are bounded by a timeout and expose the server request ID and
`Retry-After` hints. Audience, client, and required scopes are bound before a
credential is used.

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

## Integration gate

The non-production host integration (a real browser completing login against a
real hosted server) remains explicitly blocked here. Automated coverage uses
mocked browser/HTTP/listener/clock/entropy/credential boundaries plus a
Windows/Linux CLI subprocess smoke with a local mock server and no real browser,
network, or account.

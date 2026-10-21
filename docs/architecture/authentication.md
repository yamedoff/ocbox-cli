# CLI authentication and credential lifecycle

## What it does
AuthSessionService implements browser authorization-code login with S256 PKCE. CliOAuthClient exchanges and rotates credentials; HostedTokenManager coordinates credential generations. AuthenticatedHttpClient attaches bearer material only to the configured API origin and deployment subpath.

## Inside
Login generates a verifier and state, binds 127.0.0.1 on an OS-selected port at /callback, opens or prints the browser URL, accepts one matching callback and exchanges the code. The listener rejects unexpected host/path/method, duplicated protocol parameters and replayed/wrong state. It closes on every completion path.

createSessionGate uses auth.state.lock across processes. Login holds it for the state commit, not while waiting for the browser. Refresh re-reads the credential inside the gate: a waiter adopts a newer generation instead of reusing the superseded refresh token. A failed metadata commit restores the prior credential/metadata pair.

## Data it keeps
CredentialStore holds token pairs. auth.json holds the credential reference, issuer, client, audience, scopes and expiry, never the token pair. The default runtime supplies an unavailable OS-adapter port and selects ProtectedFileCredentialStore; the interface supports a real OS adapter if one is wired. An available adapter failure never silently downgrades to a file.

## States
Signed out → browser authorization pending → validated credential generation → rotated generation or signed out. Status checks both stores. Logout attempts server revocation and still clears local material if that network call fails; local cleanup failure remains an error.

## Limits and config
Source defaults: client ocb_cli, audience cli, scopes source:read/product:read/product:edit/product:run; callback /callback on loopback. Login deadline 5 minutes, HTTP deadline 30 seconds, proactive refresh skew 30 seconds. OAuth response reads are bounded at 64 KiB. HTTP redirects are disabled; cleartext transport is limited to loopback.

## When it fails
Only replay-safe requests may refresh and retry once after 401. A rejected second generation is compare-deleted without erasing another process's newer login. Refresh revocation/reuse becomes AUTH_REQUIRED. Binding mismatch fails before credential use. State-lock contention/cancellation and rollback failure produce explicit conflict, cancellation or INVALID_STATE errors.

## Code evidence
Browser login/commit/status/logout: `src/auth/service.ts:127–384`. Origin binding and replay: `src/auth/authenticated-client.ts:85–119,184–288`. Credential generations: `src/auth/token-manager.ts:223–371`. Authenticated response bounds: `src/auth/hosted-client.ts:106–284`; default credential wiring: `src/auth/runtime.ts:142–153`.

Verified against ocbox-cli @ d949442bca48a5e84b7f0a26c51a1f83b07bd202

Sign-in errors map closed public server reasons to static text and retain the server reference. The five-minute loopback deadline reports when the browser never returned. Local status errors distinguish missing metadata, unreadable state and mismatched identity/generation; the fix is logout then login using the same state directory. Logout returns revocationReason, including missing/unreadable state and invalid endpoint cases. The auth command boundary stores the last 100 failure references (at most seven days) in auth-failures.json through the atomic store; it stores no error text or sign-in material. Look up a local reference in that file; server references belong to the public API support flow.

Verified against ocbox-cli @ cd231a4 plus auth failure reporting changes.

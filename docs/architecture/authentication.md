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


## Source responsibilities

These source definitions are the navigation index for the responsibilities above. Line ranges refer to the verified source snapshot.

| Responsibility | Source |
| --- | --- |
| AuthSessionService.login | `src/auth/service.ts:127-179` |
| LoopbackCallbackListener | `src/auth/loopback.ts:154-238` |
| codeChallengeS256 | `src/auth/pkce.ts:27-30` |
| HostedTokenManager | `src/auth/token-manager.ts:315-371` |
| createHostedApiClient | `src/auth/hosted-client.ts:303-324` |
| AuthSessionService.status | `src/auth/service.ts:236-297` |
| AuthSessionService.logout | `src/auth/service.ts:299-366` |
| AuthenticatedHttpClient.request | `src/auth/authenticated-client.ts:184-221` |
| createSessionGate | `src/auth/session-gate.ts:30-62` |
| normalizeIssuer | `src/auth/config.ts:62-89` |
| CliOAuthClient.exchangeAuthorizationCode | `src/auth/oauth-client.ts:254-265` |
| createHostedTokenManager | `src/auth/runtime.ts:242-276` |

Verified against ocbox-cli @ 8af54e8

# CLI source delivery and local transfer recovery

## What it does
Hosted push selects content-addressed v2 for a mapped `sesdo_` Session and manifest/chunk/checksum calls for older Sessions. The fake/local validation path also has a two-sided manifest planner and journalled filesystem transfer. These paths have different capabilities and must not be described interchangeably.

## Inside
scanSourceManifest applies ignore groups, normalizes safe paths and hashes file contents. Legacy hosted push refuses remote deletion, builds a bounded archive and calls uploadPreparedSource. The upload derives idempotency keys from content, Session and predecessor receipt lineage; an A→B→A change cannot incorrectly reuse A's old successful delivery.

Each chunk is SHA-256 verified. A conflicting upload succeeds only when the server receipt has the same checksum. After verifySourceChecksum returns an operation, the client polls and re-verifies the terminal receipt. Success requires the correct manifest ID, checksum and chunk count.

The local transfer adapter stages files, records a durable intent, moves/replaces the target and updates the verified baseline under a lock. Recovery never promotes staged content and never deletes an ambiguous backup; it restores the original target or its proven absence.

V2 resolves the owned running sandbox mapping before building its transport. runCasPush applies the same safe scan and excludes the state subtree before reading it. buildCasSnapshot preserves verified unchanged bundle slices, packs initial small files into 8 MiB bundles and splits large files into 16 MiB parts. With previous state and at most 512 dirty files in total, dirty small files become individual blobs. Canonical object-key sorting hashes each bounded manifest page.

syncCasSnapshot plans each page, validates every requested blob against that page, and uploads through opaque capabilities with four workers. PUTs omit API credentials and reject redirects. createCasTransport uses the normal authenticated generated client for plan/apply; only safe categories enter typed errors. Apply replays the same key until a matching terminal receipt. Plan/apply control calls and capability PUTs use separate connections; the upload endpoint is opaque. Each PUT has a 120-second timer and retries transient failures after 1 then 2 seconds.

## Data it keeps
Source manifests, verified baselines, local transfer journals and hosted receipt/operation IDs. V2 keeps unsigned pending/success metadata and cached source blobs in an API/Session/root-scoped local state directory; URLs and credentials are never persisted there. Every invocation rehashes source and verifies cache content. Hosted push does not claim that a local baseline proves the remote workspace is unchanged.

V2 metadata and blobs are written via exclusive 0600 temporary files and rename; directory creation requests 0700. These writers do not fsync or verify Windows ACLs. Source is rehashed on each invocation, and reusable cached slices are checked by size and SHA-256.

## States
V2: scan → pack → save pending → plan/PUT → apply/poll → save success. A retry reuses a pending identity only for matching page hashes younger than 45 minutes; terminal refusals clear it. Legacy hosted: safe scan → archive → manifest → chunks → verification/apply → matching receipt. Local: plan → staged → target-moving → target-moved → committed, with explicit recovery gates. A pending journal blocks another local transfer.

## Limits and config
V2: 100,000 entries, 1 GiB total, 256 MiB per file, 4,096 blobs; pages have 512 entries/512 KiB, at most 512 pages/32 MiB metadata. PUTs have 3 attempts/120-second timers; apply checks a 15-minute loop deadline before each request and polls pending receipts after up to 1 second. Control calls/body reads have separate authenticated transport timers, so 15 minutes is not a hard end-to-end wall-clock cap. Legacy hosted source: 100 files, 64 KiB per file, 512 KiB total content, 1 MiB archive. Chunks default to 256 KiB; retryable chunk failures have at most 3 attempts. Receipt listing allows at most 100 pages and rejects repeated cursors. Apply wait defaults to 5 minutes with a 1-second healthy polling interval.

## When it fails
Hosted pull, diff and recover are refused when their hosted capability is absent; legacy hosted push with --delete is unsupported. V2 removal of paths from the local success state requires --delete and confirmation/--yes; it is not a cross-machine conflict check. Server conflicts, invalid receipts and integrity errors fail safely; interruption preserves unsigned resume state. Local deletion requires --delete and explicit confirmation/--yes. Unsafe paths, sensitive material, checksum mismatch, conflicts and incomplete recovery fail without a force/replace bypass.

## Code evidence
Transport selection: `src/sync/command.ts:31–83`, `src/providers/ocbox/provider.ts:427–470`, `src/sync/service.ts:679–920`. V2: `src/sync/cas-contract.ts:5–141`, `cas-push.ts:20–151`, `cas-snapshot.ts:37–292`, `cas-transfer.ts:22–176`, `src/providers/ocbox/cas.ts:16–101`. Local transfer: `src/sync/planner.ts:192–383`, `local-transfer-adapter.ts:129–170,311–393`, `archive.ts:144–196`; scanner: `manifest.ts:311–474`.

Verified against ocbox-cli @ d949442bca48a5e84b7f0a26c51a1f83b07bd202

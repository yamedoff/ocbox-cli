# CLI source delivery and local transfer recovery

## What it does
The hosted path uploads a safe local snapshot through manifest/chunk/checksum API calls. The fake/local validation path also has a two-sided manifest planner and journalled filesystem transfer. These paths have different capabilities and must not be described interchangeably.

## Inside
scanSourceManifest applies ignore groups, normalizes safe paths and hashes file contents. Hosted push refuses remote deletion, builds a bounded archive and calls uploadPreparedSource. The upload derives idempotency keys from content, Session and predecessor receipt lineage; an A→B→A change cannot incorrectly reuse A's old successful delivery.

Each chunk is SHA-256 verified. A conflicting upload succeeds only when the server receipt has the same checksum. After verifySourceChecksum returns an operation, the client polls and re-verifies the terminal receipt. Success requires the correct manifest ID, checksum and chunk count.

The local transfer adapter stages files, records a durable intent, moves/replaces the target and updates the verified baseline under a lock. Recovery never promotes staged content and never deletes an ambiguous backup; it restores the original target or its proven absence.

## Data it keeps
Source manifests, verified baselines, local transfer journals and hosted receipt/operation IDs. Hosted push does not claim that a local baseline proves the remote workspace is unchanged.

## States
Hosted: safe scan → archive → manifest → chunks → verification/apply → matching receipt. Local: plan → staged → target-moving → target-moved → committed, with explicit recovery gates. A pending journal blocks another local transfer.

## Limits and config
Hosted source: 100 files, 64 KiB per file, 512 KiB total content, 1 MiB archive. Chunks default to 64 KiB; retryable chunk failures have at most 3 attempts. Receipt listing allows at most 100 pages and rejects repeated cursors. Apply wait defaults to 5 minutes with a 1-second healthy polling interval.

## When it fails
Hosted pull, diff and recover are refused when their hosted capability is absent; hosted push with --delete is unsupported. Local deletion requires --delete and explicit confirmation/--yes. Unsafe paths, sensitive material, checksum mismatch, conflicts and incomplete recovery fail without a force/replace bypass.

Verified against ocbox-cli @ 4a917c828da6

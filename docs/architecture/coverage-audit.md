# Public architecture-map audit

Verified source: yamedoff/ocbox-cli staging `d949442bca48a5e84b7f0a26c51a1f83b07bd202`. Mapping branch starts at `58c6e62`. This is a local source audit, not deployed-product or installed-agent acceptance. The initial audit ran offline. The authorized publication follow-up concludes the merge and updates tracked PR #32; application files remain untouched and no Notion operations are performed.

## Result

- Map: 4 buildings (1 application, 2 outside endpoints/callers, 1 deprecated historical grouping), 37 connections, 291 code entries, 40 journeys, 8 guides.
- `node tools/map/cli.mjs check --base origin/codex/recovery-ci-validation`: 0 errors, 3 documented warnings.
- `coverage`: 0 gaps.
- `diff --base origin/codex/recovery-ci-validation`: {"changed/building":1,"added/building":1,"added/connection":2,"added/journey":14,"changed/journey":25,"added/code":176,"changed/code":55,"added/step":65,"changed/step":85,"changed/guide":7}. No removed IDs.
- `git diff --check`: clean. A comparison with staging outside the allowed map/architecture paths is empty, confirming application/tooling files were not changed by this audit.
- All 10 `tools/map/dependencies.test.mjs` tests pass.
- Leak guard invoked: skipped because LEAK_GUARD_PATTERNS is unavailable. This is not a successful configured leak scan; public-map validation and local content review are the available checks.
- All building/connection/code/journey/guide IDs from both branch HEAD and latest staging survive. Flattened journey-step IDs also survive against both tips and the merge base.
- After the local staging merge, CLI `--base` resolves to d949442. Independently checked flattened IDs against the original mapping commit and staging tip, including journey-step IDs.

## Merge conflict resolution

Resolved conflict content in map.json, cli.md and state.md by a three-way merge from the common ancestor. Retained the branch's detailed coverage and staging's execution/CAS additions, unioned guide journey links, then corrected stale facts and anchors from current source. Removed every conflict marker. Kept both detailed state paths and CAS state behavior; kept post-start safe execution errors and unknown-OS shell deferral.

Merge commit b23b826 concludes the previously unfinished merge after the user authorized git writes. The mapping follow-up commits the verified guides and audit. Application changes inherited from staging are unchanged relative to that branch; this work edits only map/architecture files and publishes only map/full-coverage.

## New staging commits

| Commit | Source change |
| --- | --- |
| 1d23bb8 | Preserve curated typed errors after accepted remote execution start; human/JSON/JSONL keep safe details and infrastructure exit 125. |
| 18e8c54 | Re-stamp execution guides against that implementation. |
| 8c1d6ce | Reject known non-Linux explicit shell targets; defer absent/partial effective metadata to the remote executor. |
| 724cf90 | Re-stamp shell compatibility guides. |
| 52e83a7 | CAS source push: contract validation, snapshot/cache/state, transfer, hosted transport, selection/progress and pinned public API additions. |
| 2097f30 | Re-stamp CAS guides. |
| accecee | Merge PR #33 (execution fixes). |
| d949442 | Merge PR #34 (content-addressed sync). |

## Coverage census

The numerical census uses tracked files under src, matching the request's 171/191 baseline. It counts file paths, not number of entries. Raw coverage is **171/191 (89.5%) → 176/196 (89.8%)**. The five added source files are src/providers/ocbox/cas.ts and src/sync/cas-{contract,push,snapshot,transfer}.ts. All are mapped. Excluding the 20 internal barrels and the generated client, coverage is **170/170 → 175/175 (100%)**. The generated client remains mapped as well; published package export surfaces remain mapped deliberately.

| src folder | Before (58c6e62) | After (staging source) |
| --- | ---: | ---: |
| (src root) | 3/3 | 3/3 |
| agents | 37/40 | 37/40 |
| api | 3/4 | 3/4 |
| auth | 17/18 | 17/18 |
| cli | 3/3 | 3/3 |
| commands | 34/34 | 34/34 |
| config | 4/5 | 4/5 |
| credentials | 3/4 | 3/4 |
| domain | 8/9 | 8/9 |
| errors | 2/3 | 2/3 |
| execution | 11/12 | 11/12 |
| lifecycle | 5/6 | 5/6 |
| metadata | 2/2 | 2/2 |
| output | 1/2 | 1/2 |
| platform | 1/2 | 1/2 |
| providers | 19/23 | 20/24 |
| security | 2/3 | 2/3 |
| state | 3/4 | 3/4 |
| sync | 13/14 | 17/18 |
| **Total** | **171/191** | **176/196** |

### Internal barrels excluded from required coverage

Each was inspected to confirm it contains exports/comments only:

- `src/agents/claude-code/index.ts`
- `src/agents/codex/index.ts`
- `src/agents/index.ts`
- `src/api/client/index.ts`
- `src/auth/index.ts`
- `src/config/index.ts`
- `src/credentials/index.ts`
- `src/domain/index.ts`
- `src/errors/index.ts`
- `src/execution/index.ts`
- `src/lifecycle/index.ts`
- `src/output/index.ts`
- `src/platform/index.ts`
- `src/providers/contract/index.ts`
- `src/providers/fake/index.ts`
- `src/providers/index.ts`
- `src/providers/ocbox/index.ts`
- `src/security/index.ts`
- `src/state/index.ts`
- `src/sync/index.ts`

### Generated code

`src/api/generated/client.ts` is generated from vendored `openapi/openapi.yaml`. It is retained as a mapped generated-client entry, but excluded from the hand-written-code denominator. The OpenAPI paths and operation IDs are public boundary evidence; no server implementation is described.

### Test and benchmark exclusions

117 test-tree files and 1 benchmark are outside the production-source census. Exact paths:

- `bench/sync-manifest.bench.ts`
- `test/agents/claude-code/claude-executable.test.ts`
- `test/agents/claude-code/hook-effective.test.ts`
- `test/agents/claude-code/hook-exec.test.ts`
- `test/agents/claude-code/hook-timeout.test.ts`
- `test/agents/claude-code/hook.test.ts`
- `test/agents/claude-code/lifecycle.test.ts`
- `test/agents/claude-code/manifest-loss.test.ts`
- `test/agents/claude-code/merge.test.ts`
- `test/agents/claude-code/parser-drift.test.ts`
- `test/agents/claude-code/path-boundary.test.ts`
- `test/agents/claude-code/policy.test.ts`
- `test/agents/claude-code/routing.test.ts`
- `test/agents/claude-code/settings-sources.test.ts`
- `test/agents/claude-code/store-atomic-write.test.ts`
- `test/agents/claude-code/store.test.ts`
- `test/agents/claude-code/t11-reconciled.test.ts`
- `test/agents/claude-code/version.test.ts`
- `test/agents/codex/durability.test.ts`
- `test/agents/codex/executable.test.ts`
- `test/agents/codex/helper-capabilities.test.ts`
- `test/agents/codex/hook.test.ts`
- `test/agents/codex/io-atomic.test.ts`
- `test/agents/codex/merge.test.ts`
- `test/agents/codex/path-boundary.test.ts`
- `test/agents/codex/planner.test.ts`
- `test/agents/codex/timeouts.test.ts`
- `test/agents/codex/version-paths.test.ts`
- `test/auth/authenticated-client.test.ts`
- `test/auth/browser.test.ts`
- `test/auth/config.test.ts`
- `test/auth/contract.test.ts`
- `test/auth/doubles.ts`
- `test/auth/hosted-client.test.ts`
- `test/auth/loopback.test.ts`
- `test/auth/metadata.test.ts`
- `test/auth/oauth-client.test.ts`
- `test/auth/pkce.test.ts`
- `test/auth/redaction.test.ts`
- `test/auth/runtime.test.ts`
- `test/auth/service.test.ts`
- `test/auth/token-manager.test.ts`
- `test/cli/hosted-runtime.test.ts`
- `test/cli/runtime.test.ts`
- `test/commands/agent/cross-adapter.test.ts`
- `test/commands/agent/hook-safety-codex.test.ts`
- `test/commands/agent/hook-safety.test.ts`
- `test/commands/agent/remove.test.ts`
- `test/commands/agent/setup.test.ts`
- `test/contracts/capabilities.test.ts`
- `test/contracts/entities.test.ts`
- `test/contracts/errors.test.ts`
- `test/contracts/execution-files.test.ts`
- `test/contracts/fixtures.test.ts`
- `test/contracts/ids.test.ts`
- `test/contracts/lifecycle.test.ts`
- `test/contracts/operation.test.ts`
- `test/contracts/provider-contract.test.ts`
- `test/contracts/public-boundary.test.ts`
- `test/contracts/spec.test.ts`
- `test/contracts/test-data.ts`
- `test/contracts/type-safety.ts`
- `test/execution/cli-arguments.test.ts`
- `test/execution/command-runner.test.ts`
- `test/execution/exit-policy.test.ts`
- `test/execution/helper-protocol.test.ts`
- `test/execution/helper-runtime.test.ts`
- `test/execution/output.test.ts`
- `test/execution/service.test.ts`
- `test/execution/stream-output.test.ts`
- `test/fixtures/agents/codex/config-with-user-hooks.toml`
- `test/fixtures/agents/codex/user-config.toml`
- `test/fixtures/claude-code/base-settings.json`
- `test/fixtures/claude-code/corrupt-settings.json`
- `test/fixtures/claude-code/managed-settings.json`
- `test/fixtures/claude-code/pinned-surface.json`
- `test/fixtures/contracts/entities.json`
- `test/fixtures/contracts/public-api.json`
- `test/image-candidate.test.ts`
- `test/infrastructure/config.test.ts`
- `test/infrastructure/credentials.test.ts`
- `test/infrastructure/output.test.ts`
- `test/infrastructure/paths.test.ts`
- `test/infrastructure/state.test.ts`
- `test/lifecycle/cancel.test.ts`
- `test/lifecycle/execution-target.test.ts`
- `test/lifecycle/lifecycle-service.test.ts`
- `test/lifecycle/streaming-auth-lock.test.ts`
- `test/metadata/client.test.ts`
- `test/package.test.ts`
- `test/providers/doubles.ts`
- `test/providers/ocbox-auth-refresh.test.ts`
- `test/providers/ocbox-authorize.test.ts`
- `test/providers/ocbox-cancel.test.ts`
- `test/providers/ocbox-checkpoints.test.ts`
- `test/providers/ocbox-contract.test.ts`
- `test/providers/ocbox-errors.test.ts`
- `test/providers/ocbox-executions.test.ts`
- `test/providers/ocbox-mapping.test.ts`
- `test/providers/ocbox-operations.test.ts`
- `test/providers/ocbox-persistence.test.ts`
- `test/providers/ocbox-provider.test.ts`
- `test/providers/ocbox-provisioning.test.ts`
- `test/providers/ocbox-reconciled.test.ts`
- `test/providers/ocbox-source.test.ts`
- `test/sync/archive.test.ts`
- `test/sync/baseline-store.test.ts`
- `test/sync/baseline.test.ts`
- `test/sync/benchmark.test.ts`
- `test/sync/cas.test.ts`
- `test/sync/exclusions.test.ts`
- `test/sync/hosted.test.ts`
- `test/sync/ignore-rules.test.ts`
- `test/sync/local-transfer-adapter.test.ts`
- `test/sync/manifest.test.ts`
- `test/sync/path-policy.test.ts`
- `test/sync/planner.test.ts`
- `test/sync/service.test.ts`

### Supporting development tools

The following executable source files are outside src and the published CLI runtime. They are build, contract-generation, audit, test, acceptance or image-verification utilities, rather than additional user CLI commands. The map kit is explained by map-tooling.md; its dependency tests were executed. These paths are listed separately rather than silently included in the 196-file denominator:

- `images/ocbox-base/entrypoint.sh`
- `images/ocbox-base/readiness.sh`
- `scripts/accept-installed.mjs`
- `scripts/accept-installed.test.mjs`
- `scripts/build-cli-manifest.mjs`
- `scripts/check-api-contract.mjs`
- `scripts/check-licenses.mjs`
- `scripts/cli-auth-bootstrap.mjs`
- `scripts/generate-api-client.mjs`
- `scripts/leak-guard.mjs`
- `scripts/leak-guard.test.mjs`
- `scripts/lib/openapi-contract.mjs`
- `scripts/lib/openapi-yaml.mjs`
- `scripts/test-cli-auth.mjs`
- `scripts/test-cli-cas-sync.mjs`
- `scripts/test-cli-exec.mjs`
- `scripts/test-cli-lifecycle.mjs`
- `scripts/test-cli-manifest.mjs`
- `scripts/test-cli-metadata.mjs`
- `scripts/test-cli-sync.mjs`
- `scripts/test-image-verifier.mjs`
- `scripts/verify-execution-helper.mjs`
- `scripts/verify-image-candidate.mjs`
- `scripts/verify-toolchain.mjs`
- `tools/map/cli.mjs`
- `tools/map/dependencies.test.mjs`
- `tools/map/mapcore.mjs`

## What was mapped and corrected

Merged the existing 260 branch code entries with staging's CAS/safe-error entries, and added smaller responsibilities for metadata dispatch, hosted get/list/effective-spec/cancel/preview revoke, operation cancellation, domain validation, auth commit and authenticated transport, CAS limits/canonical hashes/refusals/upload URL checks/workers and fake lifecycle mutations. All existing anchors are checked against current files; 13 drifted ranges were corrected, and provider-create was moved off the preview callback onto the actual method at 507–616. The generic module-domain-entities ID now points to the real ProjectSchema definition rather than a regex incorrectly consumed through an adjacent schema. Codex doctor now cites its full 1324–1571 body.

User flows distinguish hosted execution from the fake helper, CAS/legacy/local push, source deletion approval, journalled local pull/recovery, local ls from embedded provider.list, destroy tombstones/history, two-stage interrupts and safe post-start errors. Metadata CRUD journeys now cite dispatch and actual per-action inputs/results. The old generic public-api-calls ID remains, now explicitly an alternatives catalogue for callable API ports, with correct method references and no implied all-operations batch. No CLI commands call preview create/revoke or cancelHostedOperation; the catalogue says so.

Added journeys in this session beyond branch HEAD: cli-cas-sync and cli-local-sync-push. The earlier branch already adds thirteen journeys over the common ancestor; all survive. A generic source-upload-endpoints outside building plus cli-cas-upload distinguish credential-free capability PUTs from public planSourceCas/applySourceCas control calls. No backend vendor or private service topology is inferred.

All 34 command source files are mapped. Commands with effects/observations lead into journeys. The three topic-only entry points (agent, auth and sync index.ts) print usage without effects, and need no independent journey. Root binary entry/helper and exported package surfaces remain mapped. Duplicate class/run entries retain their stable IDs.

All eight guides carry code evidence ranges and the staging source verification stamp. map.dependencies.json is unchanged: new code adds no unclassified package imports.

## Warnings intentionally retained

1. C-4: collectExecutionEvents spans 331 lines (src/providers/ocbox/executions.ts:104–434). Its closures share cursor, seen events, retry attempts and deadline; the full state machine is the responsibility being explained. Splitting the anchor would hide the fallback/failure path. The summary explains this, but the checker warns unconditionally for >300 lines.
2. C-4: planCodexSetup spans 317 lines (src/agents/codex/planner.ts:452–768). One pure plan joins schema/trust, desired representations, repairs, source hashes and the manifest. Apply is mapped separately. Again the explanation does not suppress the engine's unconditional warning.
3. Anchor warning: codexDoctor's inline object return type makes anchorUnit stop at line 1324. The real function continues to 1571; the map intentionally includes its full body rather than accepting a one-line false anchor. Tooling edits were out of scope.

## Application findings left unchanged

These are source-verified gaps, not live reproductions:

- Hosted execution accepts parsed cwd/environment but createExecution sends only command and timeout (src/providers/ocbox/provider.ts:1108–1119). Those options, including agent recursion marker environment settings, do not reach this adapter's request.
- Codex apply writes the plan's captured before/after content without re-reading current target hashes (src/agents/codex/planner.ts:1227–1272; src/commands/agent/setup.ts:149–157). A concurrent edit between plan and apply can be overwritten; the old guide's claim that apply revalidated fingerprints was removed.
- Domain/metadata idempotency keys allow 16–200 characters, but authenticated transport accepts at most 128 (src/domain/ids.ts; src/auth/authenticated-client.ts:13,68–71). A 129–200-character supplied key passes the first validator but fails before HTTP dispatch.

CAS state/cache writers request private modes but do not perform the credential store's Windows ACL verification or fsync; the guides describe these durability/protection limits without claiming stronger guarantees. Event polling's fallback tail drain is best-effort (src/providers/ocbox/executions.ts:323–360); terminal result success is not proof that all output was recovered.

Verified against ocbox-cli @ d949442bca48a5e84b7f0a26c51a1f83b07bd202

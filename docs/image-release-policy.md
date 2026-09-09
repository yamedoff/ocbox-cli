# Base image release policy

The image in `images/ocbox-base` is a release candidate. Its manifest keeps the
stable gate false until T8 and T9 have published provider-internal artifacts and
recorded five successful runs with measured startup, operation latency, and cost.
The repository does not expose snapshots as a product feature.

## Rebuild and patch policy

The candidate workflow runs each Tuesday and on relevant pull requests. A change
to the base index, platform digest, Debian snapshot, Node, Corepack, pnpm, or the
execution helper requires a reviewed pull request with registry/build evidence.
Stable identifiers always resolve to an immutable digest. Tags are convenience
aliases and are never accepted as deployment evidence.

A critical vulnerability without a documented exception starts a 48-hour patch
target. An exception must name the package/CVE, affected digest, compensating
control, owner, creation date, and an expiry no more than 30 days away. Expired
exceptions fail the release gate. The previous verified digest remains available
for rollback for at least 30 days; rollback changes the provider template to that
digest and records the reason rather than rebuilding an old tag.

## Supply-chain evidence

The workflow builds `linux/amd64`, records the final digest and BuildKit
provenance, emits an SPDX JSON SBOM from the final image, and scans that same image
for critical vulnerabilities and credential material. Non-pull-request runs also
attest and sign the candidate archive through GitHub OIDC, then verify the bundle;
there is no long-lived signing key. All third-party actions use immutable commit
SHAs.

The build accepts no credential build arguments. Runtime history, environment,
cache, fixtures, and repository history must pass credential scanning. Provider
credentials and workload secrets are injected only at runtime through their
separate provider-held paths and never belong in this image.

## Current evidence boundary

On 2026-09-09, registry inspection confirmed the reviewed index digest
`sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`
contains the effective `linux/amd64` manifest
`sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa`
from docker-node commit `c4eb0858f5c522521768d5b6dc1d9f1631d4854d`.
Official npm registry metadata confirmed the Corepack and pnpm SRI values in the
manifest. The local Docker daemon is unavailable, so build, readiness, SBOM, scan,
provenance, signature, and provider benchmark claims remain unverified until the
workflow or an existing Codespace produces artifacts.

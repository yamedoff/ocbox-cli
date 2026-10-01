# Recovery validation

The recovery integration branch is `codex/recovery-cli-integration`. CI, supply-chain
and base-image workflows accept pull requests targeting this branch as well as `main`.
The image workflow retains its existing path filter; an image or workflow change is
still required to run it automatically.

The first validation candidate contains the previously reviewed image bootstrap
repair `582bcbc2172184c2a6276f9f88bdea563f3f3e00` and deterministic sync admission
repair `2368810679c086229c5403b0e38bd1d7ff525928`, based on
`db705b53df75b360fb116b73c417d81fd530d395`. Their original commits remain in the
candidate's ancestry so provenance can be checked with `git merge-base --is-ancestor`.

Accept the candidate only after Windows/Linux validation, dependency/license review,
secret scanning and the complete image workflow report successful results on its
current commit. Check run IDs and SHAs; empty, skipped or historical checks are not
acceptance. Existing Windows CLI-auth failures must be diagnosed rather than hidden
by longer timeouts or removed tests. A scanner fixture allowlist must remain narrow.

Use the toolchain pinned in `package.json` and the lockfile. Local image readiness
does not prove downstream scan, SBOM, provenance or attestation gates. These workflows
validate candidates; merging or publishing a release is a separate reviewed action.

The dependency repair advances the transitive `brace-expansion` lockfile entry from
5.0.9 to 5.0.12, preserving the pinned direct dependencies and audit threshold.
The image workflow checks the loaded Docker image ID against the config digest in
the exported OCI runtime manifest, verifying both manifest and config blob hashes.
This binds runtime settings and ordered rootfs diff IDs without relying on exporter
metadata serialization. Run 36790209610 logged the same exported config digest for
both outputs but failed the exporter metadata comparison; the exact metadata
difference remains unverified. The actual loaded/archive identity check must pass.

Windows auth harness phase diagnostics contain command names, event names, elapsed
times and mock exchange counts only. They preserve the existing timeouts and all
auth assertions. Local auth success does not resolve a hosted Windows timeout;
the refreshed hosted run must demonstrate success or identify the stalled phase.

Run 36792180776 identifies the first Windows credential-directory ACL subprocess
as the failure: it exits via the existing 10-second timeout before login persists.
The ACL script now uses .NET Framework FileInfo/DirectoryInfo security APIs directly
to avoid PowerShell module autoload and requests ACL rules as raw SIDs to avoid
account-name or domain-controller resolution. It still rejects reparse points, disables
inherited rules, sets the current user as owner, and reads the ACL back to require
current-user-only full control. The timeout and credential failure behavior remain
unchanged. Real Windows credential round-trip tests exercise this boundary; hosted
validation must independently pass before the Windows repair is accepted.

The concurrent lifecycle conflict test now holds the provider mutation behind an
explicit promise barrier until the competing command observes the reservation.
This verifies the conflict while the operation is actually pending, independently
of filesystem speed or scheduler timing.

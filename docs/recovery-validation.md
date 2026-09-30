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

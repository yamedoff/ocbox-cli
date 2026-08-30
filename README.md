# OpenCloudBox CLI

`ocbox` is the public command-line interface for OpenCloudBox. This repository
currently contains only the v0.1 foundation: an empty oclif shell, build tooling,
tests, and repository policy. Product commands are intentionally out of scope.

## Toolchain

- Node.js `24.20.0`
- Corepack `0.36.0`
- pnpm `11.24.0`

Install the exact Corepack release, activate the pinned package manager, and use
the committed lockfile:

```sh
npm install --global corepack@0.36.0
corepack enable
corepack prepare pnpm@11.24.0 --activate
pnpm install --frozen-lockfile
```

GitHub Codespaces uses the committed `.devcontainer` configuration to install
and verify this exact toolchain, enable `gh codespace ssh`, and run the frozen
install automatically whenever a codespace is created or rebuilt.

The package is named `opencloudbox` at version `0.1.0`, but publication is
disabled with `private: true` until a later registry and release review. Both
`ocbox` and `opencloudbox` resolve to the same built entrypoint.

## Validate

```sh
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test
pnpm run build
pnpm run cli:smoke
pnpm run dependencies:check
pnpm run licenses:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and
[docs/dependency-policy.md](docs/dependency-policy.md) for pinning policy.

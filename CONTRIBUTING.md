# Contributing

Open a focused branch and pull request against `main`. Keep changes within the
approved issue or milestone; architecture, dependencies, public behavior, and
security promises require maintainer approval before implementation.

Use the exact toolchain documented in the README. Before requesting review, run:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test
pnpm run build
pnpm run cli:smoke
pnpm run dependencies:check
pnpm run licenses:check
```

Never commit credentials, generated build output, local environment files, or
unrelated changes. Commit messages should explain one coherent change.

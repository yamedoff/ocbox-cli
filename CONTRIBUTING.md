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

This public repository runs a content guard for internal terms on pull requests
and branch pushes. It checks added lines and new filenames; the private pattern
list is maintained only in a repository secret. When that secret is unavailable,
including on fork pull requests, the guard skips with a notice.

PR scans compare the event's head commit with the merge base of the event's base
and head commits (the three-dot diff), using complete history. They do not use
the checkout's synthetic PR merge commit. A PR targeting an older branch can
include earlier work since that merge base; target the intended integration
branch to review just the intended slice. Push scans compare `before` and
`after`; a new branch's all-zero `before` scans all content in its first push.

To audit every tracked file in the current working tree, including uncommitted
edits, load a newline-separated pattern file into the environment and run:

```sh
LEAK_GUARD_PATTERNS="$(cat /path/to/private-patterns.txt)" node scripts/leak-guard.mjs --full-tree
```

Keep that file outside the public repository. The audit does not require a
GitHub event. It scans binary file bytes and symlink targets without following
links, excludes untracked files and submodule contents, and fails if tracked
files cannot be read or the index has unresolved conflicts. Findings are JSONL
objects with only `file`, `line`, and `pattern` (the one-based pattern index);
line zero represents a filename. It prints no matching content or expressions.
Exit status is zero for a clean scan and one for findings or an audit error.
Unlike diff scans, a full-tree audit fails if patterns are unavailable.

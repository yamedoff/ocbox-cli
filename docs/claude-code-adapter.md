# Claude Code adapter: setup, remove, and manifest-loss reconstruction

`ocbox agent setup claude-code` installs a reversible routing aid into a Claude
Code settings file and records what it owns in a sibling
`ocbox-claude-code-manifest.json`. `ocbox agent remove claude-code` removes only
that owned content and restores the pre-existing file when it can prove the
original bytes.

The manifest can be lost to a hard crash in the window between the target write
and the manifest write, or to manual deletion. `setup` and `remove` recover from
that loss deterministically, with the limits below.

## Self-healing on setup

When the owned hook and permission rule are already present and the manifest is
absent, `setup` no longer returns a bare `already-applied`. It rebuilds a
manifest from **exact owned shapes only**: the anchored owned hook command
(`^ocbox agent hook claude-code(?: --session \S+)?$`) and the exact
`Bash(ocbox exec:*)` rule. It derives `createdPointers` from the containers that
emptying those owned entries actually emptied, sets `appliedHash` to the current
target, and marks `createdFile` only when the reconstructed pre-ownership
document is empty. It writes **only the manifest**; the target bytes are not
rewritten, so repeated setup stays idempotent.

A rotation requested while the manifest is missing is handled the same way: the
base is reconstructed from owned shapes instead of recording the already-owned
document as the base, and `backupPath` is set to `null` so no backup is written
over — or mistaken for — the unknown original backup.

## Remove with a missing manifest

With a manifest, `remove` prunes exactly the containers the manifest recorded as
created. Without one, it prunes only containers that removing the exact owned
entries emptied (for example `/hooks/PreToolUse` and a now-empty `/hooks`
parent), so co-located user hooks, user rules, other events, and unrelated keys
are preserved. When removal leaves the document empty it deletes the target,
because an empty result can only have come from owned removals.

Byte-for-byte restoration is **refused** without proof: a missing manifest
provides no `backupPath` and no trusted `baseHash`, so `remove` always falls
back to the non-destructive textual prune instead of restoring bytes.

## Reconstruction limits

- The true pre-ownership bytes cannot be recovered from owned shapes. Without
  the manifest, `remove` returns the document to its reconstructed semantic
  shape, not its original formatting, key order, or comments.
- `createdFile` cannot be proven. When the reconstructed base is empty the
  adapter treats the file as owned-only and may delete it. A pre-existing empty
  `{}` file is therefore indistinguishable from an adapter-created file once the
  manifest is gone; with the manifest intact it is preserved.
- `createdPointers` and `backupPath` are inferred, not remembered. The manifest
  records `backupPath: null` after reconstruction, and a pre-existing backup on
  disk is left untouched and unreferenced.
- User edits made after a lost manifest are treated as part of the reconstructed
  base: they survive removal, but they are not attributable in a three-way
  repair plan the way manifest-tracked drift is.
- The reconstruction touches settings only. It never reads or writes real
  credentials, deploy state, or email.

These limits are exercised by `test/agents/claude-code/manifest-loss.test.ts`.

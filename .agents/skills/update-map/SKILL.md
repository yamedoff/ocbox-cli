---
name: update-map
description: Update the repo's architecture map (map.json) and its how-it-works guides so they match the code. Use at the end of a coding session that added, removed or changed a service, worker, queue, store, outside service, a call between parts, an entry point, a limit, or a user-facing flow. Also use when asked to "update the map", when `map check` fails, or when CI lists map warnings.
---

# Update the architecture map

`map.json` at the repo root describes this repo's parts (buildings, with areas inside big ones), how they talk (connections, one per protocol), the code that does each job (code entries), the flows a user or client can trigger (journeys, with loops and failure paths) and a guide per building (`docs/architecture/*.md`). The spec and depth bar are in `MAP_SPEC.md`. Notion renders all of it, so shallow or wrong entries mislead the whole team.

## Steps

1. **List the entry points.** Run `node tools/map/cli.mjs touched`, then list every route/operation, CLI command, queue or cron handler and outbound client in the touched buildings (for a first map: in the whole repo). Every one must end up in a journey step, or you write down why not.
2. **Read each code path end to end** before writing a story. Open the files; cite line ranges you opened, not ones you guessed. Write down the facts that make each step work: limits, timeouts, state changes, retries, what happens on failure. Numbers come from code or deploy config, never from memory.
3. **Edit `map.json`.**
   - New deployable part, queue, store, or **outside system the code calls** (auth, email, compute, payments…) → a building. Big buildings get `areas`, one per responsibility.
   - Each protocol between two buildings → its own connection (`via` when it passes a gateway).
   - Each responsibility → a code entry pointing at the function or method that does the work. `symbol` is the name it *defines* (`fn`, `Class`, `Class.method`, `Class.#private`), never a function it calls. Deploy configs that set runtime limits → `config` entries.
   - Each flow a user or client can trigger → a journey. Steps name `connection`, `building` and `code` (a list when a step runs several). Loops get `"repeat": true`; failure paths go in `on_failure`.
   - `serves` goes on the service that answers, with `via` set to its gateway.
   - A part was removed → remove its building, connections, code entries and the steps that use them.
   - **Never rename an id.** Fix names and summaries in place. If an id truly must change, add `"was": "<old id>"`.
4. **Check.** Run `node tools/map/cli.mjs check`. Fix every error; `--fix` corrects drifted line ranges, then re-read those entries. Fix every coverage warning (`node tools/map/cli.mjs coverage` shows them per building), or write the reason in the PR body.
5. **Diff.** Run `node tools/map/cli.mjs diff`. No id may disappear unless its code was deleted.
6. **Guides.** For every building whose code changed, update `docs/architecture/<building>.md` (new ones start from `docs/architecture/TEMPLATE.md`) and list it under `guides` in `map.json`. End it with `Verified against <repo> @ <commit>`.

Commit `map.json` and guides in the same PR as the code. In your final message and the PR summary, give the `diff` one-liner, the journeys added or changed, and the warnings left with why.

If the session changed nothing a newcomer would notice (tests, same-behavior refactors, docs), say "map unchanged" and stop.

Never include secrets, internal hostnames, customer data, or other repos' internals; calls into another repo are `"to": "openapi:<operationId>"` only. Don't edit Notion: the sync Worker updates it from the sync branch and from PRs labelled `tracked`.

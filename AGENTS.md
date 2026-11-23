<!-- architecture-map:start -->
## Architecture map (map.json)

This repo keeps an architecture map in `map.json`, with a "how it works" guide per building under `docs/architecture/` (spec: `MAP_SPEC.md`). **Everything in them is public**: write only what a reader of this repository can already see.

**When a session changes behavior, or when asked to "update the map":**

1. **List the entry points** the change touches: CLI commands, handlers, outbound clients. Each must end up in a journey step, or you state why not.
2. **Read each code path end to end** before writing stories. Cite line ranges you opened, never guessed ones. Take numbers from the code.
3. **Update `map.json`** with only what this repo's code proves: code entries per responsibility with `symbol` set to the definition (`Class.method` for methods), journeys with `repeat` and `on_failure` where the code loops or fails. Calls to the API this tool uses are `"to": "openapi:<operationId>"` from the vendored OpenAPI file; don't describe the other side. **Never rename an id**; if you must, add `"was": "<old id>"`.
4. **Run `node tools/map/cli.mjs check`**. Fix every error (`--fix` corrects drifted line ranges; re-read those entries). Fix every coverage warning, or write the reason in the PR body. Then run the repo's leak guard.
5. **Run `node tools/map/cli.mjs diff`** and confirm no id was removed unless the thing was deleted from the code.
6. **Update the guide** for every building whose code changed, ending with `Verified against <repo> @ <commit>`.

Commit `map.json` and guides **in the same PR** as the code. In the PR summary, list the journeys added or changed and the warnings left, with why.

If nothing a newcomer would notice changed (tests, same-behavior refactors, typos), say "map unchanged" and stop.
<!-- architecture-map:end -->

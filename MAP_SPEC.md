# map.json — the architecture map, written from the code

`map.json` lives at the repo root. It says **what this repo's parts are, what they talk to, how a request travels through them, and how each part works inside**. Notion draws it as a little town and keeps it in sync with the repo's sync branch.

The map is the front door for newcomers. It must be **deep enough to explain how things work** (see the depth bar below) and **true at the current commit**. `node tools/map/cli.mjs check` enforces both: errors fail CI, warnings must be fixed or explained in the PR.

## What goes in

| Section | One entry per… | Drawn as |
| --- | --- | --- |
| `buildings` | deployable part or outside service | a building (model picked by `kind`); `areas` are its rooms when you step inside |
| `connections` | way one building talks to another (one per protocol) | road, rail, pipe, wire or bridge (by `kind`) |
| `code` | function, method, route, job or config that does a job | the building's side panel, grouped by area |
| `journeys` | flow a user or client can trigger | a guided story; carts travel the roads |
| `guides` | building that needs explaining (all real ones) | a Docs page, opened with "How it works" |

The examples below describe a made-up product, **Boxes**: a web app and a CLI call an API that starts sandboxes on an outside compute provider.

### buildings

```json
{ "id": "api", "name": "Boxes API", "kind": "service", "path": "services/api", "via": "edge",
  "summary": "Public HTTP API. Checks the API key, admits the request against the plan's limits, and drives the box lifecycle on the compute provider.",
  "serves": ["openapi:createBox", "openapi:getBox", "openapi:deleteBox"],
  "areas": [
    { "id": "auth", "name": "Auth", "summary": "API keys and sessions.", "path": "services/api/src/auth" },
    { "id": "admission", "name": "Admission", "summary": "Plan limits: boxes per account, spend ceiling.", "path": "services/api/src/admission" },
    { "id": "lifecycle", "name": "Lifecycle", "summary": "creating → ready → destroying → gone, polled stage by stage.", "path": "services/api/src/lifecycle" }
  ] }
```

- `id` — lowercase slug, **stable forever** (D-7). To rename, keep the new id and add `"was": "<old id>"` once, so the Notion row and its notes carry over; `check` fails on a rename without it (C-6).
- `kind` — `app` (house) · `cdn` (tower) · `gateway` (castle) · `service` (workshop) · `worker` (factory) · `queue` (depot) · `cache` (shop) · `database` (towers) · `storage` (warehouse) · `outside` (across the water).
- `zone` — `public` (in front of the wall), `private` (behind it), `outside`. Optional; defaults from `kind`.
- `status` — `live` (default), `planned` (construction site), `deprecated` (boarded up).
- `path` — main folder, relative to the repo root. Outside buildings have none.
- `summary` — 1–2 plain sentences, ≤ 300 chars: what it does and the facts that matter.
- `serves` — public operations this building **answers**, as `openapi:<operationId>`. Put them on the service that implements them, not on the gateway in front of it (D-5); set `via` to the gateway instead.
- `via` — the gateway or edge every call to this building passes through.
- `areas` — the rooms inside a big building (≤ 16): one per responsibility. Code entries point at them with `area`. Use areas instead of inventing fake buildings.

### connections

```json
{ "id": "web-api", "from": "web", "to": "api", "via": "edge", "kind": "request", "label": "REST /v1" },
{ "id": "api-compute", "from": "api", "to": "compute", "kind": "request", "label": "control plane: create, stop, delete" },
{ "id": "api-compute-exec", "from": "api", "to": "compute", "kind": "request", "label": "toolbox: run command, upload files" }
```

- `kind` — `request` (road) · `queue` (rail) · `database` (pipe) · `event` (signal wire) · `email` (road over the bridge).
- `to` — a building id in this map, **or** `openapi:<operationId>` for a call into another repo. Never name another repo's buildings.
- One connection per protocol: two different APIs between the same pair are two connections (drawn as parallel lanes).
- `via` — a gateway the call passes through (drawn from → via → to).
- `label` — what travels on it, ≤ 80 chars. `id` — recommended; journey steps refer to it.

### code

```json
{ "id": "create-box", "building": "api", "area": "lifecycle", "name": "BoxService.create", "kind": "function",
  "path": "services/api/src/lifecycle/box-service.ts", "symbol": "BoxService.create", "lines": "120-188",
  "summary": "POST /v1/boxes. Reserves a slot (max 50 per account), asks the provider for a sandbox and polls every 2 s up to 120 s.",
  "calls": ["admit", "provider-create"] },
{ "id": "staging-limits", "building": "api", "area": "admission", "name": "Staging limits", "kind": "config",
  "path": "deploy/staging/api.toml", "summary": "Sets MAX_BOXES=50 and SPEND_CEILING_USD=1000 for staging." }
```

- One entry per **responsibility** (D-2), pointing at the function or method that does the work, not the module (D-3).
- `symbol` — the name this entry *defines*: `createBox`, `BoxService`, `BoxService.create`, `BoxService.#poll`, `def handle`, a YAML key. Not a function it calls. `check` finds the definition, works out where it really ends, and **fails when `lines` stop early or start in the wrong place** (C-5). `check --fix` corrects those ranges; it never shortens a range you widened on purpose.
- `lines` — the whole unit, `"start-end"`. A `function`/`class` over 300 lines needs a reason in its summary, or point at its methods with `Class.method` (C-4).
- `kind` — `file`, `function`, `class`, `route`, `job`, `config`. Deploy configs that set runtime limits are `config` entries on the building they configure (D-9).
- `area` — an area id of the building.
- The code panel shows the real lines, fetched by the sync. Don't paste code into the map.

### journeys

```json
{ "id": "create-box", "name": "Create a box", "trigger": "openapi:createBox",
  "summary": "From POST /v1/boxes to a ready sandbox, including the over-limit and provider-failure paths.",
  "steps": [
    { "connection": "web-api", "code": ["auth-key", "admit"], "story": "The API checks the key, then admits the request: an account may hold 50 boxes, so the 51st gets 429 limit_reached." },
    { "connection": "api-compute", "code": "provider-create", "story": "It asks the provider for a sandbox with a one-time idempotency key and stores the box as creating." },
    { "building": "api", "code": "poll-box", "repeat": true, "story": "Every 2 s it polls the provider and advances one stage; after 120 s the box is marked failed.",
      "on_failure": [
        { "building": "api", "code": "cleanup", "story": "On a provider error the box goes to destroying; the cleanup job retries delete every 5 min until it is gone." }
      ] },
    { "connection": "web-api", "story": "The client gets 201 with the box id and status ready." }
  ] }
```

- Each step points at a `connection` (the cart travels it), a `building` (the camera goes there) and the `code` running now — one id or a list of up to 5.
- `repeat: true` — the step loops (a poll, a retry, one stage per pass). Drawn with ↻.
- `on_failure` — what happens when this step fails (one level deep, ≤ 10 steps). Shown when you switch on failure paths.
- `story` — one action, present tense, ≤ 300 chars. Name the limit, timeout, state change, retry or failure that makes the step work (D-5). Avoid "handles", "processes", "manages".
- `trigger` — set when the journey starts from a public operation; Notion chains it after another repo's journey that calls that operation.

### guides

```json
{ "id": "api-guide", "title": "Boxes API: how it works", "path": "docs/architecture/api.md", "about": ["api"], "journeys": ["create-box"] }
```

- One Markdown guide per real building (D-8), in the repo next to the code. The sync copies it into Notion **Docs** (Type guide) after each merge; edit the file, not the Notion page.
- Start from `docs/architecture/TEMPLATE.md`: what it does, inside (areas), data it keeps, states, limits and config, when it fails.
- End every guide with `Verified against <repo> @ <commit>` (D-6). `check` warns when it's missing.

## Depth bar

| Rule | What good looks like | Enforced by |
| --- | --- | --- |
| D-1 | Every flow a user or client can trigger is a journey (sign in, create, run, upload, destroy, the main failure path). N real buildings usually means at least N journeys. | warn D-1 |
| D-2 | Every non-outside building with a `path` has a code entry per responsibility; usually 3 or more. | warn C-1 |
| D-3 | Code entries point at the function or method that does the work, not the module. | warn C-4 |
| D-4 | Every outside system the code calls is a building; every protocol between two buildings is a connection. | warn C-8 |
| D-5 | Stories name the facts: limits, timeouts, states, retries, failures, with numbers from code or config. | warn C-7 |
| D-6 | Every summary and story is checked against the code at the current commit; guides end with "Verified against". | warn |
| D-7 | Never rename an id; use `was` when you must. | **error C-6** |
| D-8 | Every real building has a guide. | warn C-9 |
| D-9 | Deploy configs that set runtime limits are `config` code entries. | spec |

Also checked: line ranges that stop early or start elsewhere (**error C-5**), served operations or connections no journey uses (C-2), steps with no code (C-3), big source files with no code entry (C-1).

## What never goes in

- Secrets, tokens, internal hostnames, IPs, customer data, incident details.
- Paths outside this repo, or names of other repos' buildings or files.
- Plans that aren't in the code yet (use `status: "planned"` only for work in this PR).
- In a **public** repo: anything not already public in this repo. Outside calls only as `openapi:<operationId>` from the vendored OpenAPI file.

## Commands

```bash
node tools/map/cli.mjs touched      # what your branch changed that the map and guides may care about
node tools/map/cli.mjs check        # errors fail; warnings grouped by rule (--all lists every one, --strict fails on them)
node tools/map/cli.mjs check --fix  # correct line ranges that drifted (then re-read those entries)
node tools/map/cli.mjs coverage     # per building: code, areas, journeys, guides, and what's missing
node tools/map/cli.mjs diff         # what reviewers will see in Notion (ids removed? only if the code is gone)
node tools/map/cli.mjs report       # the same as markdown, for the CI job summary
```

`check`, `diff` and `report` compare with the branch you'll merge into (`--base <ref>`, else `GITHUB_BASE_REF` in CI, else `origin/staging`, `origin/main`, `origin/master`).

## How it reaches Notion

1. You (or your coding agent) update `map.json` and the guides in the same PR as the code.
2. On PRs labelled **tracked**, the sync writes the map diff to **Map changes** and sets **Map status** on the PR page; the PR page's map shows it in review mode.
3. After a merge to the **sync branch** (the default branch, or the one set for this repo in the Worker's `MAP_REPOS` as `owner/name@branch`), the sync applies the map by id, copies the guides into Docs, and flags other docs about changed buildings as **needs review**.
4. To sync without a merge (first load, recovery): Actions → **map sync** → Run workflow. Give a PR number to refresh that PR's Map changes instead.

Notion owns the human side: **Note**, **Owner**, **Health**, pinned **X/Y**, and each row's page body. The sync never touches those.

## Explicit dependency ownership

The same vendor-agnostic engine runs in public and private repos. It contains no
vendor-name catalogue. Keep repository facts in `map.dependencies.json`:

```json
{ "version": 1, "packages": {
  "schema-library": { "kind": "library", "reason": "Validates local input; no external service calls." },
  "workspace-module": { "kind": "workspace", "reason": "Another package in this repository." },
  "compute-sdk": { "kind": "service", "reason": "Calls the service shown by this connection.", "connections": ["api-compute"] }
} }
```

C-8 warns on every unclassified non-relative import in a building's source and
its mapped code files. Service declarations must reference real connection IDs
owned by the calling building. Node-prefixed platform imports are excluded.
Malformed declarations are errors. Libraries and workspace modules require a
reason; they are not buildings. Direct fetch calls still require an outgoing
connection. This is a coverage check, not a secret scanner or publication gate.

The public repo owns client facts and public operation IDs. The private repo owns
server implementation facts. Notion joins the journeys at those operation IDs.
Review the complete public diff before pushing; a post-push content guard only
detects already-published content. Never copy a private map into a public repo.

## Calls between repos (X-1, X-2)

A public repo calls the private API only through `openapi:<operationId>` and keeps its own copy of the
OpenAPI file (`"openapi"` in its map.json). Its own `check` already fails if its map calls an operation
missing from that copy.

The repo that serves the API also checks its callers. Install the kit there with
`--callers owner/name@branch` and CI runs `node tools/map/cli.mjs callers --repo owner/name@branch`,
which reads the caller's map.json and OpenAPI copy from GitHub:

- **X-1 (error):** the caller's map uses an operation this repo's OpenAPI file no longer has, or has at a
  different method or path than the caller's copy. Fix the API change, or update the caller first.
- **X-2 (warning):** the caller's copy of the OpenAPI file differs from this repo's. Update the copy.

`--local <dir>` reads the caller from a local checkout instead of GitHub.

# map.json — the architecture map, written from the code

`map.json` lives at the repo root. It describes **what this repo's parts are, what they talk to, and how a request travels through them**. Notion draws it as a little town and keeps it in sync after every merge to `main`.

The map is the front door for newcomers. Keep it short, true, and written from the code you can see in this repo.

## What goes in

| Section | One entry per… | Drawn as |
| --- | --- | --- |
| `buildings` | deployable part or outside service | a building (model picked by `kind`) |
| `connections` | way one building talks to another | road, rail, pipe, wire or bridge (by `kind`) |
| `code` | entry point a newcomer should read | shown in the building's side panel |
| `journeys` | real flow worth explaining | a guided story with steps |

### buildings

```json
{ "id": "product-api", "name": "Product API", "kind": "worker", "path": "workers/product-api",
  "summary": "Public HTTP API for boxes. Checks the API key, then asks a provider to create the sandbox.",
  "serves": ["openapi:createBox"] }
```

- `id` — lowercase slug, **stable**. Renaming an id = removing a building and adding a new one (Notion notes stay on the old row).
- `kind` — `app` (house) · `cdn` (tower) · `gateway` (castle) · `service` (workshop) · `worker` (factory) · `queue` (depot with rails) · `cache` (shop) · `database` (towers) · `storage` (warehouse) · `outside` (across the water).
- `zone` — `public` (in front of the wall), `private` (behind it), `outside` (across the water). Optional; defaults from `kind`.
- `status` — `live` (default), `planned` (construction site), `deprecated` (boarded up).
- `path` — main folder, relative to the repo root.
- `summary` — 1–2 plain sentences, ≤ 300 chars. What it does, not how great it is.
- `serves` — public API operations this building answers, as `openapi:<operationId>`. Lets other repos connect to it without knowing its name.

### connections

```json
{ "id": "api-sandbox", "from": "product-api", "to": "sandbox-host", "kind": "request", "label": "create sandbox" }
```

- `kind` — `request` (road) · `queue` (rail) · `database` (pipe) · `event` (signal wire) · `email` (road over the bridge).
- `to` — a building id in this map, **or** `openapi:<operationId>` for a call into another repo. Never name another repo's buildings.
- `label` — what travels on it, ≤ 80 chars.
- `id` — optional but recommended (journey steps refer to it).

### code

```json
{ "id": "create-box", "building": "product-api", "name": "createBox", "kind": "route",
  "path": "workers/product-api/src/boxes.ts", "symbol": "createBox", "lines": "40-88",
  "summary": "POST /v1/boxes. Validates input, reserves a slot, starts the provider call.",
  "calls": ["provider-create"] }
```

- Keep it to the entry points a newcomer needs (usually 2–8 per building), not every function.
- `symbol` is how the checker re-finds the code when lines move. `map check --fix` updates `lines` for you.
- `kind` — `file`, `function`, `class`, `route`, `job`, `config`.
- The code panel shows the real lines from `main`, fetched by the sync. Don't paste code into the map.

### journeys

```json
{ "id": "create-box", "name": "Create a box", "summary": "From POST /v1/boxes to a running sandbox.",
  "trigger": "openapi:createBox",
  "steps": [
    { "connection": "edge-api", "code": "create-box", "story": "The request reaches the Product API. It checks the API key first." },
    { "connection": "api-sandbox", "code": "provider-create", "story": "It asks the sandbox host for a sandbox and waits up to 15 s." }
  ] }
```

- Each step points at a `connection` (the cart travels it), a `building` (the camera goes there) and/or a `code` entry (shown as "running now").
- `story` — one action per step, present tense, ≤ 300 chars, no jargon a new teammate wouldn't know.
- `trigger` — set when the journey starts from a public API operation; Notion chains it after another repo's journey that calls that operation.

## What never goes in

- Secrets, tokens, internal hostnames, IPs, customer data, incident details.
- Paths outside this repo, or names of other repos' buildings or files.
- Opinions and plans that aren't in the code yet (use `status: "planned"` for work in this PR only).
- In a **public** repo: anything not already public in this repo. Outside calls only as `openapi:<operationId>` from the vendored OpenAPI file.

## Commands

```bash
node tools/map/cli.mjs touched     # what your branch changed that the map may care about
node tools/map/cli.mjs check       # validate (paths, refs, symbols, public rules)
node tools/map/cli.mjs check --fix # re-anchor moved line ranges
node tools/map/cli.mjs diff        # what reviewers will see in Notion
```

## How it reaches Notion

1. You (or your coding agent) update `map.json` in the same commit as the code.
2. On PRs labelled **tracked**, the sync writes the map diff to **Map changes** and sets **Map status** on the PR page. The PR page's map shows it in review mode (added = construction site, changed = scaffolding, removed = boarded up).
3. After any merge to `main`, the sync applies `main`'s map to the Notion databases by key and flags docs about changed buildings as **needs review**.

Notion owns the human side: **Note**, **Owner**, pinned **X/Y**, health, and each row's page body. The sync never touches those.

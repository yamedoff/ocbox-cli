# Architecture map tooling and dependency ownership

## What it does
map.json is a repository's architecture contract. The same dependency-free mapcore engine validates public and private repositories. Explicit package classifications in map.dependencies.json replace a baked-in vendor-name catalogue.

## Inside
The engine checks stable IDs, references, areas, method anchors, journeys, failure paths and guides. A dependency is classified as library, workspace or service with a reason. A service declaration references an existing connection owned by the calling building. The scanner checks both deployment folders and explicitly mapped code files, excluding test/generated source and node-prefixed platform imports.

## Data it keeps
map.json, dependency declarations and Markdown guides live beside the code. Notion owns its database copy and human Note/Owner/Health/position fields. Changes to synced fields originate in the repo; the Worker writes them by stable Key.

## States
Author from code → check and dependency tests → reviewed public diff → tracked PR preview → merge to the configured sync branch → Worker applies map and guides. A declaration error fails the check; an unclassified import is a coverage warning that must be fixed or explained.

## Limits and config
The public repo declares only its three local libraries and public operation IDs. It has no private vendor configuration. Public and private clients share identical engine bytes. Public operation IDs are the integration boundary used to join client calls with server journeys in Notion.

## When it fails
Wrong line anchors, broken references and undeclared renames fail validation. New packages do not silently evade an old vendor catalogue: unclassified imports warn. This architecture checker does not replace secret scanning. A post-push content guard only detects already-published content, so the complete public diff must be reviewed before publication.

Verified against ocbox-cli @ 8af54e8

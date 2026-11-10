# <Building name>: how it works

<!-- One guide per real building (D-8). Write from the code at the current commit, never from memory (D-6).
     Name numbers exactly as the code or deploy config has them (limits, timeouts, retries, sizes). -->

## What it does
Two or three sentences: who calls it, what it gives back, what it owns.

## Inside
One line per area (the same areas as in map.json), with the file or folder where it lives.
- **<Area name>** (`path/`): what it is responsible for.

## Data it keeps
Tables, buckets, keys or files it writes, and who else reads them.

## States
The lifecycle of the main thing it manages, e.g. `creating → ready → destroying → gone`, and what moves it between states.

## Limits and config
Caps, timeouts, retries, quotas, feature flags, with where each one is set (code or deploy config).

## When it fails
What happens on the usual failures: what the caller sees, what is retried, what is left behind and how it is cleaned up.

Verified against <repo> @ <commit>

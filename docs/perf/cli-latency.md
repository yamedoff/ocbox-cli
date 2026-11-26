# CLI latency: where an `ocbox` command spends its time

OCB-K6-1 measured the CLI before changing it. `OCBOX_TRACE=1` makes the CLI
write one stderr line per phase with the elapsed milliseconds since process
start. It is off by default; when off it adds no timers, formatting, writes or
global `fetch` patch, and it never prints a token, an identifier, a query
string, a header or file contents.

## Turn it on

```sh
OCBOX_TRACE=1 ocbox status
```

```text
ocbox-trace phase=entry elapsed_ms=13
ocbox-trace phase=module-load elapsed_ms=50 duration_ms=37
ocbox-trace phase=http elapsed_ms=352 duration_ms=302 method=GET path=/v1/meta status=401
ocbox-trace phase=config elapsed_ms=384 duration_ms=3
ocbox-trace phase=credentials elapsed_ms=398 duration_ms=14
ocbox-trace phase=token-refresh elapsed_ms=410 duration_ms=4 network=no
ocbox-trace phase=command elapsed_ms=1200 duration_ms=800
```

`elapsed_ms` is milliseconds since process start. `duration_ms` is how long
that phase took. The `command` phase wraps the command dispatch and body, so its
`duration_ms` is that work while its `elapsed_ms` is the total wall time from
process start (startup plus command). The last `command` line's `elapsed_ms` is
therefore the number to compare with the 2 s exit criterion.

## Phases

| phase           | emitted by                          | meaning                                                                                                                                              |
| --------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entry`         | `src/index.ts`                      | Node bootstrap and the CLI's main module up to the first statement                                                                                   |
| `module-load`   | `src/index.ts`                      | loading `@oclif/core` and the startup version-gate module                                                                                            |
| `config`        | `src/cli/runtime.ts`                | each workspace `opencloudbox.toml` read and parse                                                                                                    |
| `credentials`   | `src/cli/runtime.ts`                | resolving the account state directory from auth metadata or identity                                                                                 |
| `token-refresh` | `src/api/client/client.ts`          | each token-manager refresh decision; `network=yes` means it reached the wire, `network=no` means the stored credential was reused or refused locally |
| `http`          | `src/cli/trace.ts` (global `fetch`) | each request: method, id-free path on the API origin or `:external`, status, duration; status `0` means no response arrived                          |
| `command`       | `src/index.ts`                      | oclif dispatch plus the selected command's body                                                                                                      |

HTTP paths lose their query string, host and identifier-shaped segments. For
example `/v1/projects/6f1c…/sessions?cursor=next` prints as
`path=/v1/projects/:id/sessions`. Requests outside the configured hosted API
origin — for example the short-lived CAS upload and download capabilities — are
printed as `path=:external`, so their host, path, query and token never reach
stderr. Tokens, Session/project/execution IDs and request bodies never reach
stderr. An `http` duration ends when the response headers arrive; reading the
body stays inside the `command` phase.

`ocbox exec` may be served by the optional warm-session daemon. The daemon is a
detached process whose stderr is ignored, so its requests do not appear in the
CLI's trace; the CLI's `command` phase still includes the wait for it. Record
which mode a table used, and use `OCBOX_WARM=0` when the HTTP rows of an `exec`
run must be visible.

## How the table is produced

Run each command 10 times with `OCBOX_TRACE=1`, from a real project workspace on
staging with a running box. Before each `sync push`, rewrite a 1024-byte file
with different content, so every run pushes a 1 KB change instead of a no-op.
Keep each command's stderr in its own directory, one file per run.

POSIX shell, one command per invocation:

```sh
mkdir -p traces/status traces/exec traces/push
for i in $(seq 1 10); do
  OCBOX_TRACE=1 ocbox status --json >/dev/null 2>"traces/status/$i.log"
  OCBOX_TRACE=1 ocbox exec --json -- true >/dev/null 2>"traces/exec/$i.log"
  node -e "require('node:fs').writeFileSync('change.bin', Buffer.alloc(1024, process.argv[1]))" "$i"
  OCBOX_TRACE=1 ocbox sync push --json >/dev/null 2>"traces/push/$i.log"
done
```

PowerShell on Windows:

```powershell
$env:OCBOX_TRACE = '1'
New-Item -ItemType Directory -Force traces\status, traces\exec, traces\push | Out-Null
1..10 | ForEach-Object {
  ocbox status --json 2>"traces\status\$_.log" | Out-Null
  ocbox exec --json -- true 2>"traces\exec\$_.log" | Out-Null
  [IO.File]::WriteAllBytes(
    'change.bin',
    [Text.Encoding]::ASCII.GetBytes(('{0:D4}' -f $_).PadRight(1024, 'x'))
  )
  ocbox sync push --json 2>"traces\push\$_.log" | Out-Null
}
```

`change.bin` must be inside the synced project workspace; adjust the path if the
workspace root is elsewhere. It is exactly 1024 ASCII bytes and differs on every
run.

### From stderr lines to the table

Save this as `summarize-trace.mjs` beside the `traces` directory:

```js
// Usage: node summarize-trace.mjs <log-directory> <label>
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const directory = process.argv[2] ?? 'traces'
const label = process.argv[3] ?? 'command'
const runs = new Map()

for (const name of await readdir(directory)) {
  if (!name.endsWith('.log')) continue
  const sums = new Map()
  for (const line of (await readFile(join(directory, name), 'utf8')).split('\n')) {
    if (!line.startsWith('ocbox-trace ')) continue
    const fields = Object.fromEntries(
      line
        .split(' ')
        .slice(1)
        .map((part) => {
          const at = part.indexOf('=')
          return [part.slice(0, at), part.slice(at + 1)]
        }),
    )
    let key = fields.phase
    if (key === 'http') key += ` ${fields.method} ${fields.path} ${fields.status}`
    if (key === 'token-refresh') key += ` network=${fields.network}`
    const value = Number(fields.phase === 'entry' ? fields.elapsed_ms : fields.duration_ms)
    if (Number.isFinite(value)) sums.set(key, (sums.get(key) ?? 0) + value)
    if (fields.phase === 'command') sums.set('command elapsed_ms', Number(fields.elapsed_ms))
  }
  for (const [key, value] of sums) {
    if (!runs.has(key)) runs.set(key, [])
    runs.get(key).push(value)
  }
}

function percentile(values, p) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil((p / 100) * sorted.length) - 1]
}

for (const [key, values] of [...runs].sort(([left], [right]) => left.localeCompare(right))) {
  console.log(`${label}\t${key}\t${percentile(values, 50)}\t${percentile(values, 95)}`)
}
```

Then run it once per command:

```sh
node summarize-trace.mjs traces/status status
node summarize-trace.mjs traces/exec "exec -- true"
node summarize-trace.mjs traces/push "sync push (1 KB)"
```

It prints one TSV row per phase key: `command`, `phase`, `p50 ms`, `p95 ms`.
`entry` uses `elapsed_ms` (a point marker has no `duration_ms`); every other row
uses `duration_ms`. The extra `command elapsed_ms` row is the wall time from
process start to the end of the command body, so it is the row to compare with
the 2 s exit criterion. Repeated rows with the same key in one run are added, so
each run contributes one value per key: `exec` and `sync push` read the workspace
config more than once, and repeated `http` keys are summed the same way. Group
`http` rows by method, path and status and `token-refresh` rows by `network`.
Percentiles are nearest-rank over the 10 per-run values: sort them and take
element `ceil(p/100 * 10)` (the 5th for p50, the 10th for p95). Do not average
across runs before taking percentiles.

## Reference run (not staging)

This table was produced on the Linux worktree that added the trace, against the
local fake provider, with the version gate disabled. It validates the harness
and the phase boundaries; it is **not** the staging measurement and must not be
used to cut the fix parts.

| command            | phase         | p50 duration ms | p95 duration ms | p50 elapsed ms | p95 elapsed ms |
| ------------------ | ------------- | --------------: | --------------: | -------------: | -------------: |
| `status`           | `entry`       |            14.0 |            15.0 |           14.0 |           15.0 |
| `status`           | `module-load` |            35.0 |            38.0 |           50.0 |           52.0 |
| `status`           | `config`      |             4.0 |             4.0 |           93.0 |           95.0 |
| `status`           | `command`     |            56.0 |            69.0 |          106.0 |          121.0 |
| `exec -- true`     | `entry`       |            14.0 |            16.0 |           14.0 |           16.0 |
| `exec -- true`     | `module-load` |            37.0 |            38.0 |           51.0 |           53.0 |
| `exec -- true`     | `config`      |             0.0 |             3.0 |           95.0 |           96.0 |
| `exec -- true`     | `command`     |            71.0 |            76.0 |          122.0 |          124.0 |
| `sync push` (1 KB) | `entry`       |            14.0 |            17.0 |           14.0 |           17.0 |
| `sync push` (1 KB) | `module-load` |            34.0 |            38.0 |           49.0 |           55.0 |
| `sync push` (1 KB) | `config`      |             0.0 |             4.0 |           96.0 |          100.0 |
| `sync push` (1 KB) | `command`     |            68.0 |            71.0 |          119.0 |          123.0 |

These are one 10-run sample; a rerun moves the values by a few milliseconds.
The percentile method is the part to reproduce, not these exact numbers.

The same commands with the version gate enabled, still against the local fake
provider, add one real staging request per run:

| command            | phase                   | p50 duration ms | p95 duration ms | p50 elapsed ms | p95 elapsed ms |
| ------------------ | ----------------------- | --------------: | --------------: | -------------: | -------------: |
| `status`           | `http GET /v1/meta 401` |           174.0 |           204.0 |          234.0 |          272.0 |
| `exec -- true`     | `http GET /v1/meta 401` |           179.0 |           225.0 |          240.0 |          284.0 |
| `sync push` (1 KB) | `http GET /v1/meta 401` |           172.0 |           195.0 |          236.0 |          257.0 |

## Staging measurement

The live table is produced by the commands above against staging with a real
project, a running box and a fresh 1 KB change. It is intentionally empty here:
this part adds the trace and the measuring steps, not a staging measurement.
Fill it from the owner's Windows PC after this part merges, then paste the
`summarize-trace.mjs` rows into the table. Do not seed auth state or create a
staging box by hand.

| command            | phase                                    | p50 duration ms | p95 duration ms |
| ------------------ | ---------------------------------------- | --------------: | --------------: |
| `status`           | `entry`                                  |               — |               — |
| `status`           | `module-load`                            |               — |               — |
| `status`           | `config`                                 |               — |               — |
| `status`           | `credentials`                            |               — |               — |
| `status`           | `token-refresh network=no`               |               — |               — |
| `status`           | `http GET /v1/projects/:id/sessions 200` |               — |               — |
| `status`           | `command`                                |               — |               — |
| `status`           | `command elapsed_ms`                     |               — |               — |
| `exec -- true`     | `entry`                                  |               — |               — |
| `exec -- true`     | `module-load`                            |               — |               — |
| `exec -- true`     | `config`                                 |               — |               — |
| `exec -- true`     | `credentials`                            |               — |               — |
| `exec -- true`     | `token-refresh network=no`               |               — |               — |
| `exec -- true`     | `http …` (each request)                  |               — |               — |
| `exec -- true`     | `command`                                |               — |               — |
| `exec -- true`     | `command elapsed_ms`                     |               — |               — |
| `sync push` (1 KB) | `entry`                                  |               — |               — |
| `sync push` (1 KB) | `module-load`                            |               — |               — |
| `sync push` (1 KB) | `config`                                 |               — |               — |
| `sync push` (1 KB) | `credentials`                            |               — |               — |
| `sync push` (1 KB) | `token-refresh network=no`               |               — |               — |
| `sync push` (1 KB) | `http …` (each request)                  |               — |               — |
| `sync push` (1 KB) | `command`                                |               — |               — |
| `sync push` (1 KB) | `command elapsed_ms`                     |               — |               — |

## What the reference run says about the biggest phase

The local reference run is dominated by `command` (the oclif dispatch and
command body), then `module-load`; `entry` and `config` are small. Enabling the
version gate adds a real staging request that is larger than any local startup
phase (p50 about 170–180 ms, p95 up to about 225 ms). That makes the startup
gate and the command phase the first two things to split before cutting fix
parts: `command` currently includes oclif's command discovery and the selected
command module load, so a staging table that shows `command` as the largest
row must be broken down before attributing the 5–8 s to product work.

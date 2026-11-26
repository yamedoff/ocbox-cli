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

Run each command 10 times with `OCBOX_TRACE=1`, keep the stderr lines from each
run, and take p50/p95 of `duration_ms` per phase (`elapsed_ms` for the point
marker `entry`). Group `http` rows by method, path and status, and
`token-refresh` rows by `network`. `exec` and `sync push` read the workspace
config more than once, so each read prints its own `config` line; sum the
`config` durations within a run before taking percentiles. Use a real project
and a running box on staging; the 1 KB change is a file of exactly 1024 bytes
created before the first push.

POSIX shell, one command per invocation:

```sh
mkdir -p traces
for i in $(seq 1 10); do
  OCBOX_TRACE=1 ocbox status --json >/dev/null 2>"traces/status-$i.log"
  OCBOX_TRACE=1 ocbox exec --json -- true >/dev/null 2>"traces/exec-$i.log"
  OCBOX_TRACE=1 ocbox sync push --json >/dev/null 2>"traces/push-$i.log"
done
```

PowerShell on Windows:

```powershell
$env:OCBOX_TRACE = '1'
1..10 | ForEach-Object {
  ocbox status --json 2>"traces\status-$_.log" | Out-Null
  ocbox exec --json -- true 2>"traces\exec-$_.log" | Out-Null
  ocbox sync push --json 2>"traces\push-$_.log" | Out-Null
}
```

Parse one file per run and keep one value per phase per run; the table below
uses the p50 and p95 of those values. Do not average across runs before taking
the percentiles.

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

The same commands with the version gate enabled, still against the local fake
provider, add one real staging request per run:

| command            | phase                   | p50 duration ms | p95 duration ms | p50 elapsed ms | p95 elapsed ms |
| ------------------ | ----------------------- | --------------: | --------------: | -------------: | -------------: |
| `status`           | `http GET /v1/meta 401` |           174.0 |           204.0 |          234.0 |          272.0 |
| `exec -- true`     | `http GET /v1/meta 401` |           179.0 |           225.0 |          240.0 |          284.0 |
| `sync push` (1 KB) | `http GET /v1/meta 401` |           172.0 |           195.0 |          236.0 |          257.0 |

## Staging measurement

The live table is produced by the commands above against staging with a real
project, a running box and a 1 KB change. It is **not filled in this worktree**:
the machine has no usable staging CLI auth (a protected credential exists, but
its binding metadata `auth.json` is absent, so the CLI records
`cli_auth_metadata_missing` and refuses it), no `OCB_STAGING_*` secret is in the
environment, and the shared live-probe runner is paused. The three product
commands therefore cannot complete here, and the exit criterion also asks for a
Windows PC while this worktree is Linux. The release `Release staging smoke`
workflow holds `OCB_STAGING_CLI_TOKEN` and runs on `windows-latest`; a
measurement step there, or a run on the Windows PC used for the exit criterion,
is the sanctioned place to fill this table. Do not seed auth state or create a
staging box by hand to work around the missing credential.

| command            | phase                                    | p50 duration ms | p95 duration ms |
| ------------------ | ---------------------------------------- | --------------: | --------------: |
| `status`           | `entry`                                  |               — |               — |
| `status`           | `module-load`                            |               — |               — |
| `status`           | `config`                                 |               — |               — |
| `status`           | `credentials`                            |               — |               — |
| `status`           | `token-refresh network=no`               |               — |               — |
| `status`           | `http GET /v1/projects/:id/sessions 200` |               — |               — |
| `status`           | `command`                                |               — |               — |
| `exec -- true`     | `entry`                                  |               — |               — |
| `exec -- true`     | `module-load`                            |               — |               — |
| `exec -- true`     | `config`                                 |               — |               — |
| `exec -- true`     | `credentials`                            |               — |               — |
| `exec -- true`     | `token-refresh network=no`               |               — |               — |
| `exec -- true`     | `http …` (each request)                  |               — |               — |
| `exec -- true`     | `command`                                |               — |               — |
| `sync push` (1 KB) | `entry`                                  |               — |               — |
| `sync push` (1 KB) | `module-load`                            |               — |               — |
| `sync push` (1 KB) | `config`                                 |               — |               — |
| `sync push` (1 KB) | `credentials`                            |               — |               — |
| `sync push` (1 KB) | `token-refresh network=no`               |               — |               — |
| `sync push` (1 KB) | `http …` (each request)                  |               — |               — |
| `sync push` (1 KB) | `command`                                |               — |               — |

## What the reference run says about the biggest phase

The local reference run is dominated by `command` (the oclif dispatch and
command body), then `module-load`; `entry` and `config` are small. Enabling the
version gate adds a real staging request that is larger than any local startup
phase (p50 about 170–180 ms, p95 up to about 225 ms). That makes the startup
gate and the command phase the first two things to split before cutting fix
parts: `command` currently includes oclif's command discovery and the selected
command module load, so a staging table that shows `command` as the largest
row must be broken down before attributing the 5–8 s to product work.

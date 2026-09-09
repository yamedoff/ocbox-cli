# Execution engine

`runExecutionCommand` is the provider-neutral `ocbox exec` command runner. A thin
oclif adapter supplies the resolved Session/provider target when the lifecycle
command layer is composed. This slice does not register a provider-specific
command or claim remote isolation.

## Grammar and validation

Structured mode is `ocbox exec [OPTIONS] -- ARGV...`. Every argument remains a
separate string through parsing, `ExecRequest`, the helper request frame, and
`spawn(executable, args, {shell: false})`. Empty arguments, spaces, Unicode, and
shell metacharacters remain literal. Explicit shell mode is
`ocbox exec [OPTIONS] --shell COMMAND`; it is mutually exclusive with argv mode
and maps only to `/bin/bash -lc COMMAND` on a compatible Linux image.

Options include `--session`, normalized absolute sandbox `--cwd`, positive
millisecond `--timeout`, repeatable non-secret `--env NAME=VALUE`, and mutually
exclusive `--json`/`--jsonl`. Parsing and target validation finish before the
provider mutation. The target must contain the selected active Session, its
active primary running Sandbox, and streaming plus cancellation capabilities.
Explicit Session IDs, provider timeout limits, shell compatibility, environment
names/values, and output mode are checked before execution.

## Streams, cancellation, and exit policy

`started`, `stdout`, `stderr`, and `completed` events carry one execution ID,
strictly increasing global sequence values, and nondecreasing UTC timestamps.
Bytes remain bytes in memory. Human output writes them directly. JSONL emits each
event in order with byte fields encoded as base64. JSON drains the complete stream
while retaining a bounded prefix per stream, then emits total/retained byte counts
and exact truncation flags. Every sink write is awaited, so the provider iterator
is the backpressure boundary and output floods do not create an unbounded buffer.

The first Ctrl-C requests provider cancellation. A second Ctrl-C returns 130
without waiting for a stuck cancellation request and does not destroy the Session.
Timeout and cancellation are typed terminal outcomes. If cancellation fails but a
remote terminal result arrives, that result remains authoritative.

| Outcome | CLI exit | Structured discriminator |
| --- | ---: | --- |
| Remote exit or signal | Remote 0–255 code | `remote_result` |
| Timeout | 124 | `timeout` |
| Before-start/provider/transport failure | 125 | `infrastructure_error` |
| Interrupt without observed terminal result | 130 | `cancelled` |

A remote program may itself return 124, 125, or 130. JSON and JSONL therefore
always carry the discriminator rather than asking automation to infer an outcome
from the process code.

## Fake-provider scope and evidence

`FakeProviderExecution` uses `LocalProcessExecutionHarness` to exercise the public
provider port deterministically. The harness starts processes on the developer or
CI host. It is only a contract/integration test fixture and is neither a sandbox
adapter nor proof of isolation. It uses a bounded producer queue, tears down the
process tree on timeout/cancellation, and stops producers when a consumer abandons
the event stream.

The test matrix covers literal argv values, Unicode split boundaries, binary
frames, malformed/truncated/oversized frames, shell gating, nonzero and reserved
remote exits, missing binaries, signals where supported, output floods,
backpressure, disconnects, result/event disagreement, timeout, process-tree
cancellation, cancellation failure, first/repeated interrupts, safe error
envelopes, and credential-shaped diagnostic canaries. CI runs the suite on Windows
and Ubuntu with the pinned toolchain. Real provider transport, image installation,
TTY/stdin, output retention, and provider-specific quoting remain later tasks.

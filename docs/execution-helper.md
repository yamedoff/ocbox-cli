# Execution helper protocol v1

The built helper is `dist/execution-helper.js`. The helper build emits a single
self-contained bundle with its production dependencies inlined and no shared
chunks, so T7 can install it at a constant image path without a `node_modules`
tree. Provider adapters invoke that constant command
(`/opt/ocbox/bin/ocbox-exec-helper.js`) and pass protocol frames through a
binary-safe channel. To negotiate the wire version, run
`node dist/execution-helper.js --protocol-version`. Version 1 prints exactly `1`
followed by a newline, writes nothing to stderr, and exits 0.

The adapter sends one unsigned 32-bit big-endian byte length, followed by one
UTF-8 JSON request, then closes the request channel. The decoder consumes EOF
before execution can start. Truncated input, additional frames, invalid UTF-8,
unknown versions and bodies exceeding 1 MiB fail without exposing input values.
Protocol v1 does not multiplex program stdin or offer a TTY.

Helper output uses the same framing: each event is a four-byte unsigned
big-endian length followed by one UTF-8 JSON object. Event frames carry protocol
version, execution ID, global sequence, UTC timestamp, and event type. Workload
stdout/stderr bytes are base64 encoded at this transport boundary. The decoder
holds at most one bounded frame and rejects truncated, oversized, malformed, or
unknown-version frames.

The request contains version, execution ID, a discriminated argv/shell command,
sandbox working directory, non-secret environment settings, and optional timeout.
Environment validation rejects conventional credential keys and recognized secret
formats. It is not a general secret classifier; workload secrets must use the
separate provider-held secret-reference path, never this channel.

Argv mode preserves every argument, including empty arguments and metacharacters.
The helper must invoke the returned executable/vector with `shell: false` inside
the sandbox. Explicit shell mode requires a Bash-capable image and uses the fixed
executable `/bin/bash` with `['-lc', script]`. A provider SDK accepting command
strings may invoke only a constant helper command and send this framed request
through its binary-safe input channel. It must never interpolate user arguments.

The helper emits `started` only after Node confirms that the workload process was
spawned. A missing or unstartable executable therefore produces no started or
terminal result frame; the helper writes a fixed safe diagnostic and exits 125.
Once started, exit 0, nonzero exit, and signal termination are terminal
`ExecResult` values. Timeout and cancellation terminate the complete process tree,
first gracefully and then forcibly after a bounded grace period. They never stop
or destroy the enclosing Session.

Tests enumerate every two-chunk split and every truncated prefix of a Unicode
request, reject trailing frames and excessive advertised sizes before body reads,
round-trip binary event frames across every split point, and verify shell gating.
The packaged-helper smoke test asserts the exact version-probe contract. These
tests prove the helper and host-local harness; T8/T9 must still prove each real
provider transport and remote process-tree behavior.

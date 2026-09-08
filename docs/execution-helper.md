# Execution helper protocol v1

This is the transport foundation for T5. The runnable remote helper, stream
multiplexer, cancellation state machine and CLI integration are still pending.

The adapter sends one unsigned 32-bit big-endian byte length, followed by one
UTF-8 JSON request, then closes the request channel. The decoder consumes EOF
before execution can start. Truncated input, additional frames, invalid UTF-8,
unknown versions and bodies exceeding 1 MiB fail without exposing input values.
Protocol v1 does not multiplex program stdin or offer a TTY.

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

Tests enumerate every two-chunk split and every truncated prefix of a Unicode
request, reject trailing frames and excessive advertised sizes before body reads,
and verify shell gating. Passing protocol tests does not prove a provider's
transport, remote process-tree cancellation, or cross-platform execution.

#!/bin/bash
set -euo pipefail

fail() {
  printf 'readiness failed: %s\n' "$1" >&2
  exit 1
}

[[ "$(id -u)" == "10001" ]] || fail 'runtime uid'
[[ "$(id -g)" == "10001" ]] || fail 'runtime gid'
[[ "$HOME" == "/home/ocbox" ]] || fail 'home'
[[ "$PWD" == "/workspace" ]] || fail 'workspace'
[[ "$(umask)" == "0027" ]] || fail 'umask'
[[ -w /workspace ]] || fail 'workspace is not writable'
[[ ! -S /var/run/docker.sock ]] || fail 'docker socket is mounted'
command -v sudo >/dev/null 2>&1 && fail 'sudo is installed'

for command_name in bash node corepack pnpm git ssh curl tar gzip xz jq rg patch make g++ python3 tini ocbox; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing ${command_name}"
done

[[ "$(node --version)" == "v24.20.0" ]] || fail 'node version'
[[ "$(corepack --version)" == "0.36.0" ]] || fail 'corepack version'
[[ "$(pnpm --version)" == "11.24.0" ]] || fail 'pnpm version'
[[ "$(node /opt/ocbox/bin/ocbox-exec-helper.js --protocol-version)" == "1" ]] || fail 'execution helper'
ocbox --version >/dev/null || fail 'compiled cli'

# mktemp forces mode 0600, so create the probe file with a normal redirect to
# observe the runtime umask (027 gives owner rw, group r, other none).
probe_directory="$(mktemp -d /workspace/.ocbox-readiness.XXXXXX)"
probe_path="${probe_directory}/probe"
trap 'rm -rf "$probe_directory"' EXIT
printf 'ready\n' >"$probe_path"
[[ "$(stat -c '%u:%g:%a' "$probe_path")" == "10001:10001:640" ]] || fail 'workspace ownership or mode'

getent hosts registry.npmjs.org >/dev/null 2>&1 || fail 'dns'
curl --fail --silent --show-error --max-time 10 https://registry.npmjs.org/-/ping >/dev/null || fail 'https'
git --version >/dev/null

printf '{"ready":true,"schemaVersion":1}\n'

#!/bin/sh
# Install the OpenCloudBox CLI into the current user's home directory.
# Usage: curl -fsSL <install url>/install.sh | sh
set -eu

# Keep in sync with package.json engines.node.
MIN_NODE_MAJOR=22
DEFAULT_RELEASE_BASE="https://github.com/yamedoff/ocbox-cli/releases/latest/download"
LATEST_RELEASE_API="https://api.github.com/repos/yamedoff/ocbox-cli/releases/latest"

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'ocbox install: %s\n' "$*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 ||
  fail "Node.js ${MIN_NODE_MAJOR} or newer is required. Install it from https://nodejs.org/ and run this again."

node_version=$(node -p 'process.versions.node' 2>/dev/null || true)
if [ -z "$node_version" ]; then
  node_version=$(node --version 2>/dev/null || true)
fi
node_version=${node_version#v}
node_major=${node_version%%.*}
case "$node_major" in
  '' | *[!0-9]*)
    fail "Could not read the Node.js version. Install Node.js ${MIN_NODE_MAJOR} or newer from https://nodejs.org/ and run this again."
    ;;
esac
[ "$node_major" -ge "$MIN_NODE_MAJOR" ] ||
  fail "Node.js ${MIN_NODE_MAJOR} or newer is required (found ${node_version}). Install it from https://nodejs.org/ and run this again."

command -v npm >/dev/null 2>&1 ||
  fail "npm was not found. Install Node.js ${MIN_NODE_MAJOR} or newer from https://nodejs.org/ and run this again."

release_base=${OCBOX_RELEASE_BASE:-$DEFAULT_RELEASE_BASE}
release_base=${release_base%/}
version=${OCBOX_VERSION:-}
version=${version#v}

if [ -z "$version" ]; then
  if [ -d "$release_base" ]; then
    found=""
    for candidate in "$release_base"/ocbox-*.tgz; do
      [ -f "$candidate" ] || continue
      [ -z "$found" ] ||
        fail "More than one release tarball was found in ${release_base}. Set OCBOX_VERSION."
      found=$candidate
    done
    [ -n "$found" ] || fail "No release tarball was found in ${release_base}. Set OCBOX_VERSION."
    version=${found##*/}
    version=${version#ocbox-}
    version=${version%.tgz}
  elif [ "$release_base" != "$DEFAULT_RELEASE_BASE" ]; then
    command -v curl >/dev/null 2>&1 ||
      fail "curl is required to read the latest release version."
    tag=$(curl -fsSL "$release_base/LATEST") ||
      fail "Could not read the latest release version from ${release_base}."
    version=$(printf '%s' "$tag" | tr -d '[:space:]')
    [ -n "$version" ] || fail "Could not read the latest release version."
    version=${version#v}
  else
    command -v curl >/dev/null 2>&1 ||
      fail "curl is required to download the latest release."
    release_json=$(curl -fsSL "$LATEST_RELEASE_API") ||
      fail "Could not find the latest release."
    tag=$(printf '%s' "$release_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=/"tag_name"\s*:\s*"([^"]+)"/.exec(s);if(m)process.stdout.write(m[1])})')
    [ -n "$tag" ] || fail "Could not read the latest release version."
    version=${tag#v}
  fi
fi

[ -n "$version" ] || fail "Could not determine the release version."
tarball_name="ocbox-${version}.tgz"

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/ocbox-install.XXXXXX") ||
  fail "Could not create a temporary directory."
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT HUP INT TERM

fetch_asset() {
  asset=$1
  destination=$2
  if [ -d "$release_base" ]; then
    [ -f "$release_base/$asset" ] ||
      fail "Release asset ${asset} was not found in ${release_base}."
    cp "$release_base/$asset" "$destination" ||
      fail "Could not copy ${asset}."
  else
    command -v curl >/dev/null 2>&1 ||
      fail "curl is required to download release assets."
    curl -fsSL "$release_base/$asset" -o "$destination" ||
      fail "Could not download ${asset}."
  fi
}

fetch_asset "$tarball_name" "$tmp_dir/$tarball_name"
fetch_asset "SHA256SUMS" "$tmp_dir/SHA256SUMS"

expected=$(awk -v name="$tarball_name" '{ file=$2; sub(/^\*/, "", file); sub(/\r$/, "", file); if (file == name) { print $1; exit } }' "$tmp_dir/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS does not list ${tarball_name}."

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp_dir/$tarball_name" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp_dir/$tarball_name" | awk '{ print $1 }')
elif command -v openssl >/dev/null 2>&1; then
  actual=$(openssl dgst -sha256 "$tmp_dir/$tarball_name" | awk '{ print $NF }')
else
  fail "No SHA-256 tool was found (sha256sum, shasum, or openssl)."
fi

expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
actual=$(printf '%s' "$actual" | tr 'A-F' 'a-f')
[ "$actual" = "$expected" ] ||
  fail "Checksum mismatch for ${tarball_name}. Refusing to install."

[ -n "${HOME:-}" ] || fail "HOME is not set."
prefix="$HOME/.ocbox"
bin_dir="$prefix/bin"
mkdir -p "$prefix" || fail "Could not create ${prefix}."
npm install -g --prefix "$prefix" "$tmp_dir/$tarball_name" ||
  fail "npm install failed."

[ -e "$bin_dir/ocbox" ] || fail "The ocbox command was not installed in ${bin_dir}."

case ":${PATH:-}:" in
  *":$bin_dir:"*) ;;
  *) say "export PATH=\"$bin_dir:\$PATH\"" ;;
esac

installed_version=$("$bin_dir/ocbox" --version) ||
  fail "The installed ocbox command could not run."
say "$installed_version"

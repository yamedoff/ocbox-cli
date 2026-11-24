/**
 * Single source of truth for the public release location and asset names.
 * `install.sh`, `install.ps1`, and `ocbox update` must all agree on these
 * values; the install scripts cannot import TypeScript, so a test pins their
 * literals to this module.
 */
export const RELEASE_BASE_URL = 'https://github.com/yamedoff/ocbox-cli/releases/latest/download'
export const LATEST_RELEASE_API_URL =
  'https://api.github.com/repos/yamedoff/ocbox-cli/releases/latest'
export const CHECKSUM_FILE_NAME = 'SHA256SUMS.txt'
export const RELEASE_TARBALL_PREFIX = 'ocbox-'

/** `ocbox-<version>.tgz`, the name produced by scripts/pack-release.mjs. */
export function releaseTarballName(version: string): string {
  return `${RELEASE_TARBALL_PREFIX}${version}.tgz`
}

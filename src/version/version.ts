/**
 * Version handling shared by the update command and the API compatibility gate.
 * Only the numeric major.minor.patch core participates: a release tag such as
 * `v0.2.0` and a build suffix are normalized away, exactly as the install
 * scripts strip a leading `v`.
 */
export interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i

export function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(value.trim())
  if (match === null) return undefined
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part) && part >= 0)) {
    return undefined
  }
  return { major, minor, patch }
}

/** Returns a negative number when `left` is older, positive when newer, 0 when equal. */
export function compareVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return undefined
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

export function isVersionOlder(current: string, minimum: string): boolean {
  const comparison = compareVersions(current, minimum)
  return comparison !== undefined && comparison < 0
}

/** Strips a leading `v`, matching the install scripts' `version=${version#v}`. */
export function normalizeVersion(value: string): string {
  const trimmed = value.trim()
  return /^v\d/i.test(trimmed) ? trimmed.slice(1) : trimmed
}

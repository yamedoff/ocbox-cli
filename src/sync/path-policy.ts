import { z } from 'zod'

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const DRIVE_OR_UNC = /^(?:[A-Za-z]:|[/\\]{2})/

/** Detects C0, DEL and C1 control characters without embedding them in a regex. */
export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true
    }
  }
  return false
}

export const ManifestPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((path) => Buffer.byteLength(path, 'utf8') <= 4_096)
  .refine((path) => path === path.normalize('NFC'))
  .refine((path) => !path.startsWith('/') && !DRIVE_OR_UNC.test(path))
  .refine((path) => !path.includes('\\'))
  .refine((path) => !hasControlCharacter(path))
  .refine((path) => {
    const segments = path.split('/')
    return segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes(':') &&
        !segment.endsWith('.') &&
        !segment.endsWith(' ') &&
        Buffer.byteLength(segment, 'utf8') <= 255 &&
        !WINDOWS_DEVICE.test(segment),
    )
  })
  .brand<'ManifestPath'>()

export type ManifestPath = z.infer<typeof ManifestPathSchema>

export type ManifestPathErrorCode =
  | 'ABSOLUTE_OR_DRIVE_PATH'
  | 'CONTROL_CHARACTER'
  | 'EMPTY_OR_TRAVERSAL_SEGMENT'
  | 'NON_CANONICAL_UNICODE'
  | 'NTFS_STREAM_OR_DRIVE'
  | 'PATH_TOO_LONG'
  | 'RESERVED_NAME'
  | 'TRAILING_DOT_OR_SPACE'
  | 'WINDOWS_SEPARATOR'

export class ManifestPathError extends Error {
  constructor(readonly code: ManifestPathErrorCode) {
    super(`Unsafe source path: ${code}`)
    this.name = 'ManifestPathError'
  }
}

/** Validates an already POSIX-separated relative path and returns NFC form. */
export function normalizeManifestPath(input: string): ManifestPath {
  if (Buffer.byteLength(input, 'utf8') > 4_096) throw new ManifestPathError('PATH_TOO_LONG')
  if (DRIVE_OR_UNC.test(input) || input.startsWith('/')) {
    throw new ManifestPathError('ABSOLUTE_OR_DRIVE_PATH')
  }
  if (input.includes('\\')) throw new ManifestPathError('WINDOWS_SEPARATOR')
  if (hasControlCharacter(input)) throw new ManifestPathError('CONTROL_CHARACTER')
  if (input !== input.normalize('NFC')) throw new ManifestPathError('NON_CANONICAL_UNICODE')
  const segments = input.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new ManifestPathError('EMPTY_OR_TRAVERSAL_SEGMENT')
  }
  if (segments.some((segment) => segment.includes(':'))) {
    throw new ManifestPathError('NTFS_STREAM_OR_DRIVE')
  }
  if (segments.some((segment) => segment.endsWith('.') || segment.endsWith(' '))) {
    throw new ManifestPathError('TRAILING_DOT_OR_SPACE')
  }
  if (
    segments.some(
      (segment) => Buffer.byteLength(segment, 'utf8') > 255 || WINDOWS_DEVICE.test(segment),
    )
  ) {
    throw new ManifestPathError('RESERVED_NAME')
  }
  return ManifestPathSchema.parse(input)
}

export interface PathCollision {
  readonly canonicalPath: ManifestPath
  readonly kind: 'case' | 'unicode'
  readonly sourcePaths: readonly string[]
}

/**
 * Reports names that collapse on case-insensitive or NFC-normalizing hosts.
 * Raw paths are used only for the report and must not be persisted as a baseline.
 */
export function findPathCollisions(rawPaths: readonly string[]): readonly PathCollision[] {
  const normalizedGroups = new Map<string, string[]>()
  for (const raw of rawPaths) {
    const normalized = raw.normalize('NFC')
    const group = normalizedGroups.get(normalized) ?? []
    group.push(raw)
    normalizedGroups.set(normalized, group)
  }

  const collisions: PathCollision[] = []
  for (const [normalized, sources] of normalizedGroups) {
    if (new Set(sources).size > 1) {
      const parsed = ManifestPathSchema.safeParse(normalized)
      if (parsed.success) {
        collisions.push({ canonicalPath: parsed.data, kind: 'unicode', sourcePaths: sources })
      }
    }
  }

  const caseGroups = new Map<string, string[]>()
  for (const normalized of normalizedGroups.keys()) {
    const key = normalized.toLowerCase()
    const group = caseGroups.get(key) ?? []
    group.push(normalized)
    caseGroups.set(key, group)
  }
  for (const sources of caseGroups.values()) {
    if (sources.length > 1) {
      const canonical = sources.toSorted((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      )[0]
      const parsed = ManifestPathSchema.safeParse(canonical)
      if (parsed.success) {
        collisions.push({ canonicalPath: parsed.data, kind: 'case', sourcePaths: sources })
      }
    }
  }
  return collisions.toSorted((left, right) =>
    Buffer.compare(Buffer.from(left.canonicalPath), Buffer.from(right.canonicalPath)),
  )
}

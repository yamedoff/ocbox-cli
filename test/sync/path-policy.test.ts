import { describe, expect, it } from 'vitest'
import {
  findPathCollisions,
  type ManifestPathError,
  normalizeManifestPath,
} from '../../src/sync/path-policy.js'

describe('sync path policy', () => {
  it.each([
    ['/etc/passwd', 'ABSOLUTE_OR_DRIVE_PATH'],
    ['C:/Users/Ada/file', 'ABSOLUTE_OR_DRIVE_PATH'],
    ['//server/share/file', 'ABSOLUTE_OR_DRIVE_PATH'],
    ['\\\\?\\C:\\device', 'ABSOLUTE_OR_DRIVE_PATH'],
    ['\\server\\share', 'WINDOWS_SEPARATOR'],
    ['..\\escape', 'WINDOWS_SEPARATOR'],
    ['a/../b', 'EMPTY_OR_TRAVERSAL_SEGMENT'],
    ['a/b/..', 'EMPTY_OR_TRAVERSAL_SEGMENT'],
    ['.', 'EMPTY_OR_TRAVERSAL_SEGMENT'],
    ['a//b', 'EMPTY_OR_TRAVERSAL_SEGMENT'],
    ['file:stream', 'NTFS_STREAM_OR_DRIVE'],
    ['dir/a:plain', 'NTFS_STREAM_OR_DRIVE'],
    ['CON', 'RESERVED_NAME'],
    ['dir/NUL.txt', 'RESERVED_NAME'],
    ['dir/COM1.txt', 'RESERVED_NAME'],
    ['dir/com9', 'RESERVED_NAME'],
    ['dir/trailing. ', 'TRAILING_DOT_OR_SPACE'],
    ['dir/file. ', 'TRAILING_DOT_OR_SPACE'],
    ['line\nfeed', 'CONTROL_CHARACTER'],
    ['c1\u0085break', 'CONTROL_CHARACTER'],
    ['nul\u0000byte', 'CONTROL_CHARACTER'],
    ['e\u0301.txt', 'NON_CANONICAL_UNICODE'],
  ] as const)('rejects hostile or non-portable path %s', (path, code) => {
    expect(() => normalizeManifestPath(path)).toThrowError(
      expect.objectContaining<Partial<ManifestPathError>>({ code }),
    )
  })

  it('accepts a canonical portable Unicode path', () => {
    expect(normalizeManifestPath('src/émoji🙂 file.ts')).toBe('src/émoji🙂 file.ts')
  })

  it('reports case and Unicode-normalization collisions deterministically', () => {
    expect(
      findPathCollisions(['src/a.ts', 'SRC/A.ts', 'notes/é.txt', 'notes/e\u0301.txt']),
    ).toEqual([
      { canonicalPath: 'SRC/A.ts', kind: 'case', sourcePaths: ['src/a.ts', 'SRC/A.ts'] },
      {
        canonicalPath: 'notes/é.txt',
        kind: 'unicode',
        sourcePaths: ['notes/é.txt', 'notes/e\u0301.txt'],
      },
    ])
  })
})

import { createHash } from 'node:crypto'
import { copyFile, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newRequestId } from '../auth/errors.js'
import { OcboxError } from '../errors/index.js'
import { normalizeVersion } from '../version/version.js'
import { CHECKSUM_FILE_NAME, LATEST_RELEASE_API_URL, RELEASE_BASE_URL } from './source.js'

export type ReleaseSourceKind = 'directory' | 'mirror' | 'github'

export interface ReleaseSource {
  readonly base: string
  readonly kind: ReleaseSourceKind
}

export interface ReleaseFetchOptions {
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly timeoutMilliseconds?: number | undefined
}

const ASSET_TIMEOUT_MILLISECONDS = 5 * 60_000

function releaseError(
  code: 'CONFIG_INVALID' | 'PROVIDER_UNAVAILABLE',
  message: string,
): OcboxError {
  return new OcboxError({ code, message, requestId: newRequestId() })
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Mirrors install.sh: a configured local directory wins, then a non-default
 * mirror, then the canonical GitHub release API.
 */
export async function resolveReleaseSource(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ReleaseSource> {
  // Environment is an index signature; bracket access is required by TypeScript.
  // biome-ignore lint/complexity/useLiteralKeys: see explanation above
  const configured = environment['OCBOX_RELEASE_BASE']?.trim()
  const base = (
    configured === undefined || configured === '' ? RELEASE_BASE_URL : configured
  ).replace(/\/+$/, '')
  if (await isDirectory(base)) return { base, kind: 'directory' }
  return { base, kind: base === RELEASE_BASE_URL ? 'github' : 'mirror' }
}

/** `OCBOX_VERSION` pins a release exactly as the install scripts allow. */
export function requestedReleaseVersion(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // Environment is an index signature; bracket access is required by TypeScript.
  // biome-ignore lint/complexity/useLiteralKeys: see explanation above
  const configured = environment['OCBOX_VERSION']?.trim()
  if (configured === undefined || configured === '') return undefined
  return normalizeVersion(configured)
}

async function responseText(response: Response): Promise<string> {
  if (!response.ok) {
    throw releaseError('PROVIDER_UNAVAILABLE', 'Could not read the latest release version.')
  }
  return (await response.text()).trim()
}

export async function latestReleaseVersion(
  source: ReleaseSource,
  options: ReleaseFetchOptions & { readonly requestedVersion?: string | undefined } = {},
): Promise<string> {
  if (options.requestedVersion !== undefined && options.requestedVersion !== '') {
    return options.requestedVersion
  }
  if (source.kind === 'directory') {
    const tarballs = (await readdir(source.base)).filter(
      (name) => name.startsWith('ocbox-') && name.endsWith('.tgz'),
    )
    if (tarballs.length === 0) {
      throw releaseError(
        'CONFIG_INVALID',
        'No release tarball was found in the release directory. Set OCBOX_VERSION.',
      )
    }
    if (tarballs.length > 1) {
      throw releaseError(
        'CONFIG_INVALID',
        'More than one release tarball was found in the release directory. Set OCBOX_VERSION.',
      )
    }
    const name = tarballs[0] as string
    // Keep the exact filename-derived version: install.sh accepts a local
    // `ocbox-v0.2.0.tgz`, so the tarball name must stay byte-for-byte the same.
    const version = name.slice('ocbox-'.length, -'.tgz'.length).trim()
    if (version === '') {
      throw releaseError('CONFIG_INVALID', 'Could not determine the release version.')
    }
    return version
  }
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (source.kind === 'mirror') {
    const response = await fetchImpl(`${source.base}/LATEST`, {
      headers: { accept: 'text/plain' },
      signal: AbortSignal.timeout(options.timeoutMilliseconds ?? ASSET_TIMEOUT_MILLISECONDS),
    })
    const tag = await responseText(response)
    const version = normalizeVersion(tag)
    if (version === '') {
      throw releaseError('CONFIG_INVALID', 'Could not read the latest release version.')
    }
    return version
  }
  const response = await fetchImpl(LATEST_RELEASE_API_URL, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(options.timeoutMilliseconds ?? ASSET_TIMEOUT_MILLISECONDS),
  })
  if (!response.ok) {
    throw releaseError('PROVIDER_UNAVAILABLE', 'Could not find the latest release.')
  }
  const body: unknown = await response.json()
  const tag =
    body !== null && typeof body === 'object' && 'tag_name' in body
      ? (body as { tag_name?: unknown }).tag_name
      : undefined
  if (typeof tag !== 'string' || tag.trim() === '') {
    throw releaseError('CONFIG_INVALID', 'Could not read the latest release version.')
  }
  return normalizeVersion(tag)
}

function safeAssetName(name: string): boolean {
  return name !== '' && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..'
}

export async function fetchReleaseAsset(
  source: ReleaseSource,
  name: string,
  destination: string,
  options: ReleaseFetchOptions = {},
): Promise<void> {
  if (!safeAssetName(name)) {
    throw releaseError('CONFIG_INVALID', 'The release asset name is not valid.')
  }
  if (source.kind === 'directory') {
    try {
      await copyFile(join(source.base, name), destination)
    } catch {
      throw releaseError(
        'CONFIG_INVALID',
        `Release asset ${name} was not found in the release directory.`,
      )
    }
    return
  }
  const fetchImpl = options.fetch ?? globalThis.fetch
  const response = await fetchImpl(`${source.base}/${name}`, {
    headers: { accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(options.timeoutMilliseconds ?? ASSET_TIMEOUT_MILLISECONDS),
  })
  if (!response.ok) {
    throw releaseError('PROVIDER_UNAVAILABLE', `Could not download ${name}.`)
  }
  await writeFile(destination, Buffer.from(await response.arrayBuffer()))
}

/** Reads the expected lowercase SHA-256 for `asset` from a SHA256SUMS file. */
export async function readExpectedChecksum(checksumPath: string, asset: string): Promise<string> {
  const text = await readFile(checksumPath, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    const digest = parts[0]
    const listed = parts[1]
    if (digest === undefined || listed === undefined) continue
    if (listed.replace(/^\*/, '') !== asset) continue
    const normalized = digest.toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(normalized)) break
    return normalized
  }
  throw releaseError('CONFIG_INVALID', `${CHECKSUM_FILE_NAME} does not list ${asset}.`)
}

export async function verifyReleaseChecksum(file: string, expected: string): Promise<void> {
  const actual = createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
  if (actual !== expected.toLowerCase()) {
    throw releaseError(
      'CONFIG_INVALID',
      'Checksum mismatch for the release tarball. Refusing to install.',
    )
  }
}

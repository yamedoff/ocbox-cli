import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRequestId } from '../auth/errors.js'
import { OcboxError } from '../errors/index.js'
import { cliVersion } from '../version/current.js'
import { compareVersions, normalizeVersion } from '../version/version.js'
import {
  currentPackageRoot,
  type InstalledLayout,
  installedLayout,
  installReleaseTarball,
} from './install.js'
import {
  fetchReleaseAsset,
  latestReleaseVersion,
  type ReleaseFetchOptions,
  readExpectedChecksum,
  requestedReleaseVersion,
  resolveReleaseSource,
  verifyReleaseChecksum,
} from './release.js'
import { CHECKSUM_FILE_NAME, releaseTarballName } from './source.js'

export interface UpdateOptions {
  /** Report the release that would be installed without downloading it. */
  readonly check?: boolean | undefined
  readonly currentVersion?: string | undefined
  /** The installed package directory; defaults to the running CLI's package. */
  readonly packageRoot?: string | undefined
  readonly environment?: NodeJS.ProcessEnv | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly timeoutMilliseconds?: number | undefined
  /** Test seam for the npm install plus verified directory swap. */
  readonly installTarball?:
    | ((
        tarball: string,
        layout: InstalledLayout,
        expectedVersion: string,
        environment: NodeJS.ProcessEnv,
      ) => Promise<void>)
    | undefined
}

export interface UpdateResult {
  readonly currentVersion: string
  readonly latestVersion: string
  readonly updateAvailable: boolean
  readonly updated: boolean
}

export async function runUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  const environment = options.environment ?? process.env
  const currentVersion = options.currentVersion ?? cliVersion()
  const source = await resolveReleaseSource(environment)
  const fetchOptions: ReleaseFetchOptions = {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  }
  const requestedVersion = requestedReleaseVersion(environment)
  let latestVersion: string
  try {
    latestVersion = await latestReleaseVersion(source, {
      ...fetchOptions,
      requestedVersion,
    })
  } catch (error) {
    if (error instanceof OcboxError) throw error
    throw new OcboxError({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'Could not reach the release source.',
      requestId: newRequestId(),
    })
  }
  const comparison = compareVersions(latestVersion, currentVersion)
  const updateAvailable = comparison !== undefined && comparison > 0
  if (options.check === true) {
    return { currentVersion, latestVersion, updateAvailable, updated: false }
  }
  // Never replace a working CLI with an older release. An explicit
  // OCBOX_VERSION pin wins, exactly as it does in the install scripts.
  const pinned = requestedVersion !== undefined && requestedVersion !== ''
  if (comparison === 0 || (!pinned && !updateAvailable)) {
    return { currentVersion, latestVersion, updateAvailable, updated: false }
  }

  const layout = installedLayout(options.packageRoot ?? currentPackageRoot())
  const tarballName = releaseTarballName(latestVersion)
  const expectedVersion = normalizeVersion(latestVersion)
  let workDirectory: string
  try {
    workDirectory = await mkdtemp(join(tmpdir(), 'ocbox-update-'))
  } catch {
    throw new OcboxError({
      code: 'INTERNAL',
      message: 'ocbox update could not create a temporary directory.',
      requestId: newRequestId(),
    })
  }
  try {
    const tarballPath = join(workDirectory, tarballName)
    const checksumPath = join(workDirectory, CHECKSUM_FILE_NAME)
    await fetchReleaseAsset(source, tarballName, tarballPath, fetchOptions)
    await fetchReleaseAsset(source, CHECKSUM_FILE_NAME, checksumPath, fetchOptions)
    const expected = await readExpectedChecksum(checksumPath, tarballName)
    // Verify the checksum before npm ever reads the tarball.
    await verifyReleaseChecksum(tarballPath, expected)
    const install = options.installTarball ?? installReleaseTarball
    await install(tarballPath, layout, expectedVersion, environment)
  } catch (error) {
    if (error instanceof OcboxError) throw error
    throw new OcboxError({
      code: 'INTERNAL',
      message: 'ocbox update failed.',
      requestId: newRequestId(),
    })
  } finally {
    await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
  return { currentVersion, latestVersion, updateAvailable, updated: true }
}

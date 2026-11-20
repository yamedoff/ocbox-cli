import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliVersion } from '../version/current.js'
import { compareVersions } from '../version/version.js'
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
  const latestVersion = await latestReleaseVersion(source, {
    ...fetchOptions,
    requestedVersion: requestedReleaseVersion(environment),
  })
  const comparison = compareVersions(latestVersion, currentVersion)
  const updateAvailable = comparison !== undefined && comparison > 0
  if (options.check === true) {
    return { currentVersion, latestVersion, updateAvailable, updated: false }
  }
  if (latestVersion === currentVersion) {
    return { currentVersion, latestVersion, updateAvailable: false, updated: false }
  }

  const layout = installedLayout(options.packageRoot ?? currentPackageRoot())
  const tarballName = releaseTarballName(latestVersion)
  const workDirectory = await mkdtemp(join(tmpdir(), 'ocbox-update-'))
  try {
    const tarballPath = join(workDirectory, tarballName)
    const checksumPath = join(workDirectory, CHECKSUM_FILE_NAME)
    await fetchReleaseAsset(source, tarballName, tarballPath, fetchOptions)
    await fetchReleaseAsset(source, CHECKSUM_FILE_NAME, checksumPath, fetchOptions)
    const expected = await readExpectedChecksum(checksumPath, tarballName)
    // Verify the checksum before npm ever reads the tarball.
    await verifyReleaseChecksum(tarballPath, expected)
    const install = options.installTarball ?? installReleaseTarball
    await install(tarballPath, layout, latestVersion, environment)
  } finally {
    await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
  return { currentVersion, latestVersion, updateAvailable, updated: true }
}

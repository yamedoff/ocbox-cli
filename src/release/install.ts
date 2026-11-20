import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { newRequestId } from '../auth/errors.js'
import { OcboxError } from '../errors/index.js'

const execFileAsync = promisify(execFile)
const PACKAGE_NAME = 'opencloudbox'
const INSTALL_TIMEOUT_MILLISECONDS = 5 * 60_000
const VERIFY_TIMEOUT_MILLISECONDS = 30_000

export interface InstalledLayout {
  /** The `opencloudbox` package directory that holds `dist/`. */
  readonly packageRoot: string
  /** npm's global prefix that owns `packageRoot`. */
  readonly prefix: string
}

function installError(message: string): OcboxError {
  return new OcboxError({ code: 'PROVIDER_UNAVAILABLE', message, requestId: newRequestId() })
}

/** The installed package directory of the currently running CLI. */
export function currentPackageRoot(): string {
  const localRequire = createRequire(import.meta.url)
  return dirname(localRequire.resolve(`${PACKAGE_NAME}/package.json`))
}

/**
 * Only a global npm layout can be replaced in place. A checkout or a pnpm store
 * path is rejected rather than overwriting the wrong tree.
 */
export function installedLayout(packageRoot: string): InstalledLayout {
  const nodeModules = dirname(packageRoot)
  if (basename(nodeModules) !== 'node_modules' || basename(packageRoot) !== PACKAGE_NAME) {
    throw new OcboxError({
      code: 'CONFIG_INVALID',
      message:
        'ocbox update can only replace an installed ocbox; reinstall with the install script.',
      requestId: newRequestId(),
    })
  }
  const prefix =
    basename(dirname(nodeModules)) === 'lib' ? dirname(dirname(nodeModules)) : dirname(nodeModules)
  return { packageRoot, prefix }
}

export async function readPackageVersion(packageRoot: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw installError('The downloaded ocbox package has no version.')
  }
  return manifest.version
}

async function findInstalledPackage(stagingPrefix: string): Promise<string> {
  const candidates = [
    join(stagingPrefix, 'lib', 'node_modules', PACKAGE_NAME),
    join(stagingPrefix, 'node_modules', PACKAGE_NAME),
  ]
  for (const candidate of candidates) {
    try {
      if ((await stat(join(candidate, 'package.json'))).isFile()) return candidate
    } catch {
      /* Try the next layout. */
    }
  }
  throw installError('npm install did not create the ocbox package.')
}

async function npmInstall(
  tarball: string,
  stagingPrefix: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  try {
    await execFileAsync(npm, ['install', '-g', '--prefix', stagingPrefix, tarball], {
      env: {
        ...environment,
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
      },
      shell: process.platform === 'win32',
      timeout: INSTALL_TIMEOUT_MILLISECONDS,
      windowsHide: true,
    })
  } catch {
    throw installError('npm install failed.')
  }
}

async function verifyInstalledPackage(packageRoot: string, expectedVersion: string): Promise<void> {
  const version = await readPackageVersion(packageRoot)
  if (version !== expectedVersion) {
    throw installError('The downloaded ocbox package does not match the requested version.')
  }
  const entry = join(packageRoot, 'dist', 'index.js')
  try {
    if (!(await stat(entry)).isFile()) throw new Error('missing entry')
    await execFileAsync(process.execPath, [entry, '--version'], {
      timeout: VERIFY_TIMEOUT_MILLISECONDS,
      windowsHide: true,
    })
  } catch {
    throw installError('The downloaded ocbox command could not run.')
  }
}

/**
 * Installs the tarball into a staging prefix beside the real one, verifies the
 * new command, then swaps the package directory. The swap is rename-based on
 * every platform: a running binary can be renamed on Windows, and POSIX rename
 * keeps the replacement atomic within the same filesystem.
 */
export async function installReleaseTarball(
  tarball: string,
  layout: InstalledLayout,
  expectedVersion: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const stagingPrefix = await mkdtemp(join(layout.prefix, '.ocbox-update-'))
  try {
    await npmInstall(tarball, stagingPrefix, environment)
    const stagedPackage = await findInstalledPackage(stagingPrefix)
    await verifyInstalledPackage(stagedPackage, expectedVersion)
    await replaceInstalledPackage(layout.packageRoot, stagedPackage)
  } finally {
    await rm(stagingPrefix, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function replaceInstalledPackage(target: string, replacement: string): Promise<void> {
  const backup = `${target}.ocbox-old-${process.pid}`
  await rm(backup, { recursive: true, force: true }).catch(() => undefined)
  await rename(target, backup)
  try {
    await rename(replacement, target)
  } catch (error) {
    await rename(backup, target).catch(() => undefined)
    throw error
  }
  // Windows can keep the old running image locked until this process exits;
  // leaving the backup behind is harmless and never blocks the new version.
  await rm(backup, { recursive: true, force: true }).catch(() => undefined)
}

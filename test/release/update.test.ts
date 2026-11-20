import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installedLayout } from '../../src/release/install.js'
import { runUpdate } from '../../src/release/update.js'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const roots: string[] = []
let root: string
let release: string
let tarballName: string
let checksum: string
let installCounter = 0

function unixEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: join(root, 'home'),
    npm_config_audit: 'false',
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    ...extra,
  }
}

async function makeTarball(version: string): Promise<void> {
  const source = join(root, `fixture-${version}`)
  await mkdir(join(source, 'dist'), { recursive: true })
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'opencloudbox',
      version,
      bin: { ocbox: 'dist/index.js' },
      files: ['dist'],
    }),
  )
  await writeFile(
    join(source, 'dist', 'index.js'),
    `#!/usr/bin/env node\nconsole.log('${version}')\n`,
  )
  execFileSync(npmCommand, ['pack', '--pack-destination', release], {
    cwd: source,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  })
  await rename(join(release, `opencloudbox-${version}.tgz`), join(release, tarballName))
  checksum = createHash('sha256')
    .update(await readFile(join(release, tarballName)))
    .digest('hex')
  await writeFile(join(release, 'SHA256SUMS'), `${checksum}  ${tarballName}\n`)
  await writeFile(join(release, 'LATEST'), `${version}\n`)
}

async function makeInstalled(version: string): Promise<{ packageRoot: string; prefix: string }> {
  installCounter += 1
  const prefix = join(root, `prefix-${installCounter}`)
  const packageRoot = join(prefix, 'lib', 'node_modules', 'opencloudbox')
  await mkdir(join(packageRoot, 'dist'), { recursive: true })
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'opencloudbox', version, bin: { ocbox: 'dist/index.js' } }),
  )
  await writeFile(
    join(packageRoot, 'dist', 'index.js'),
    `#!/usr/bin/env node\nconsole.log('${version}')\n`,
  )
  return { packageRoot, prefix }
}

interface Mirror {
  readonly origin: string
  readonly requests: string[]
  close(): Promise<void>
}

async function makeMirror(directory: string): Promise<Mirror> {
  const requests: string[] = []
  const server = createServer((request, response) => {
    const name = decodeURIComponent(request.url ?? '/').replace(/^\//, '')
    requests.push(`/${name}`)
    if (name === '' || name.includes('/') || name.includes('\\')) {
      response.statusCode = 404
      response.end()
      return
    }
    readFile(join(directory, name)).then(
      (body) => {
        response.statusCode = 200
        response.end(body)
      },
      () => {
        response.statusCode = 404
        response.end()
      },
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('the release mirror did not bind a TCP port')
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ocbox-update-test-'))
  roots.push(root)
  release = join(root, 'release')
  await mkdir(release, { recursive: true })
  tarballName = 'ocbox-0.2.0.tgz'
  await makeTarball('0.2.0')
})

afterAll(async () => {
  await Promise.all(roots.map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ocbox update', () => {
  it('reports the latest release with --check without downloading it', async () => {
    const { packageRoot } = await makeInstalled('0.1.0')
    const mirror = await makeMirror(release)
    try {
      const result = await runUpdate({
        check: true,
        currentVersion: '0.1.0',
        packageRoot,
        environment: unixEnvironment({ OCBOX_RELEASE_BASE: mirror.origin }),
        fetch: globalThis.fetch,
      })

      expect(result).toEqual({
        currentVersion: '0.1.0',
        latestVersion: '0.2.0',
        updateAvailable: true,
        updated: false,
      })
      expect(mirror.requests).toEqual(['/LATEST'])
      expect(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version).toBe(
        '0.1.0',
      )
    } finally {
      await mirror.close()
    }
  })

  it('downloads, checks, installs, and replaces the installed package', async () => {
    const { packageRoot, prefix } = await makeInstalled('0.1.0')
    const mirror = await makeMirror(release)
    try {
      const result = await runUpdate({
        currentVersion: '0.1.0',
        packageRoot,
        environment: unixEnvironment({ OCBOX_RELEASE_BASE: mirror.origin }),
        fetch: globalThis.fetch,
      })

      expect(result).toEqual({
        currentVersion: '0.1.0',
        latestVersion: '0.2.0',
        updateAvailable: true,
        updated: true,
      })
      expect(mirror.requests).toEqual(['/LATEST', `/${tarballName}`, '/SHA256SUMS'])
      const installed = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
      expect(installed.version).toBe('0.2.0')
      expect(await readFile(join(packageRoot, 'dist', 'index.js'), 'utf8')).toContain('0.2.0')
      const siblings = await readdir(join(prefix, 'lib', 'node_modules'))
      expect(siblings).toEqual(['opencloudbox'])
    } finally {
      await mirror.close()
    }
  })

  it('refuses a tampered checksum and leaves the installed package alone', async () => {
    const { packageRoot } = await makeInstalled('0.1.0')
    const tampered = join(root, 'tampered-release')
    await mkdir(tampered, { recursive: true })
    for (const name of [tarballName, 'LATEST']) {
      await writeFile(join(tampered, name), await readFile(join(release, name)))
    }
    await writeFile(join(tampered, 'SHA256SUMS'), `${'0'.repeat(64)}  ${tarballName}\n`)
    const mirror = await makeMirror(tampered)
    try {
      await expect(
        runUpdate({
          currentVersion: '0.1.0',
          packageRoot,
          environment: unixEnvironment({ OCBOX_RELEASE_BASE: mirror.origin }),
          fetch: globalThis.fetch,
        }),
      ).rejects.toThrow(/checksum mismatch/i)
      expect(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version).toBe(
        '0.1.0',
      )
    } finally {
      await mirror.close()
    }
  })

  it('installs from a local release directory, the same source the install script accepts', async () => {
    const { packageRoot } = await makeInstalled('0.1.0')
    const result = await runUpdate({
      currentVersion: '0.1.0',
      packageRoot,
      environment: unixEnvironment({ OCBOX_RELEASE_BASE: release }),
    })

    expect(result.latestVersion).toBe('0.2.0')
    expect(result.updated).toBe(true)
    expect(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version).toBe(
      '0.2.0',
    )
  })

  it('rejects a package directory that is not a global npm install', () => {
    expect(() => installedLayout(join(root, 'checkout', 'opencloudbox'))).toThrow(
      /can only replace an installed ocbox/,
    )
  })
})

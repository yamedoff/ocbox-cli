import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { OcboxError } from '../../src/errors/index.js'
import { installedLayout, installReleaseTarball } from '../../src/release/install.js'
import { runUpdate } from '../../src/release/update.js'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const roots: string[] = []
let root: string
let release: string
let tarballName: string
let installCounter = 0

function unixEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  // A developer or CI pin must never decide which release these tests install.
  delete environment['OCBOX_VERSION']
  return {
    ...environment,
    HOME: join(root, 'home'),
    npm_config_audit: 'false',
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    ...extra,
  }
}

async function makeTarball(
  version: string,
  directory: string = release,
  name: string = `ocbox-${version}.tgz`,
): Promise<void> {
  const source = join(root, `fixture-${version}-${++installCounter}`)
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
  execFileSync(npmCommand, ['pack', '--pack-destination', directory], {
    cwd: source,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  })
  await rename(join(directory, `opencloudbox-${version}.tgz`), join(directory, name))
  const checksum = createHash('sha256')
    .update(await readFile(join(directory, name)))
    .digest('hex')
  await writeFile(join(directory, 'SHA256SUMS'), `${checksum}  ${name}\n`)
  await writeFile(join(directory, 'LATEST'), `${version}\n`)
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

  it('rejects a pnpm global store path resolved through its symlink', async () => {
    const globalRoot = join(root, `pnpm-global-${++installCounter}`)
    const storePackage = join(
      globalRoot,
      '.pnpm',
      'opencloudbox@0.1.0',
      'node_modules',
      'opencloudbox',
    )
    await mkdir(storePackage, { recursive: true })
    await writeFile(
      join(storePackage, 'package.json'),
      JSON.stringify({ name: 'opencloudbox', version: '0.1.0' }),
    )
    const linkParent = join(globalRoot, 'node_modules')
    await mkdir(linkParent, { recursive: true })
    const link = join(linkParent, 'opencloudbox')
    await symlink(storePackage, link, 'dir')
    const resolved = await realpath(link)

    expect(() => installedLayout(resolved)).toThrow(/can only replace an installed ocbox/)
  })

  it('does not replace a newer CLI with an older release', async () => {
    const { packageRoot } = await makeInstalled('0.2.0')
    const older = join(root, `release-older-${++installCounter}`)
    await mkdir(older, { recursive: true })
    await makeTarball('0.1.0', older)

    const result = await runUpdate({
      currentVersion: '0.2.0',
      packageRoot,
      environment: unixEnvironment({ OCBOX_RELEASE_BASE: older }),
    })

    expect(result.updated).toBe(false)
    expect(result.updateAvailable).toBe(false)
    expect(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version).toBe(
      '0.2.0',
    )
  })

  it('lets an explicit OCBOX_VERSION pin win over the update direction', async () => {
    const { packageRoot } = await makeInstalled('0.2.0')
    const pinned = join(root, `release-pinned-${++installCounter}`)
    await mkdir(pinned, { recursive: true })
    await makeTarball('0.1.0', pinned)

    const result = await runUpdate({
      currentVersion: '0.2.0',
      packageRoot,
      environment: unixEnvironment({
        OCBOX_RELEASE_BASE: pinned,
        OCBOX_VERSION: '0.1.0',
      }),
    })

    expect(result.latestVersion).toBe('0.1.0')
    expect(result.updated).toBe(true)
    expect(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version).toBe(
      '0.1.0',
    )
  })

  it('installs a local release whose tarball keeps the v prefix', async () => {
    const { packageRoot } = await makeInstalled('0.1.0')
    const prefixed = join(root, `release-prefixed-${++installCounter}`)
    await mkdir(prefixed, { recursive: true })
    await makeTarball('0.2.0', prefixed, 'ocbox-v0.2.0.tgz')

    const result = await runUpdate({
      currentVersion: '0.1.0',
      packageRoot,
      environment: unixEnvironment({ OCBOX_RELEASE_BASE: prefixed }),
    })

    expect(result.latestVersion).toBe('v0.2.0')
    expect(result.updated).toBe(true)
    expect(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version).toBe(
      '0.2.0',
    )
  })

  it('sweeps a stale backup left by an earlier update', async () => {
    const { packageRoot, prefix } = await makeInstalled('0.1.0')
    const stale = join(prefix, 'lib', 'node_modules', 'opencloudbox.ocbox-old-999999')
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, 'old.txt'), 'old')
    const mirror = await makeMirror(release)
    try {
      await runUpdate({
        currentVersion: '0.1.0',
        packageRoot,
        environment: unixEnvironment({ OCBOX_RELEASE_BASE: mirror.origin }),
        fetch: globalThis.fetch,
      })
      await expect(stat(stale)).rejects.toThrow()
    } finally {
      await mirror.close()
    }
  })

  it('reports a local npm failure as INTERNAL with a bounded stderr tail', async () => {
    const { prefix } = await makeInstalled('0.1.0')
    const bin = join(root, `fake-npm-${++installCounter}`)
    await mkdir(bin, { recursive: true })
    if (process.platform === 'win32') {
      // The updater runs npm.cmd on Windows; a POSIX `npm` script would be
      // ignored and the real npm would report a missing tarball instead.
      await writeFile(
        join(bin, 'npm.cmd'),
        '@echo off\r\necho npm ERR! code E404 1>&2\r\necho token=supersecret 1>&2\r\nexit /b 1\r\n',
      )
    } else {
      const fakeNpm = join(bin, 'npm')
      await writeFile(
        fakeNpm,
        '#!/bin/sh\necho "npm ERR! code E404" >&2\necho "token=supersecret" >&2\nexit 1\n',
      )
      await chmod(fakeNpm, 0o755)
    }
    const environment = unixEnvironment({
      PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
    })

    const error = await installReleaseTarball(
      join(root, 'unused.tgz'),
      { packageRoot: join(prefix, 'lib', 'node_modules', 'opencloudbox'), prefix },
      '0.2.0',
      environment,
    ).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(OcboxError)
    expect((error as OcboxError).code).toBe('INTERNAL')
    expect((error as OcboxError).message).toContain('npm ERR! code E404')
    expect((error as OcboxError).message).not.toContain('supersecret')
  })

  it('reports an unreachable release source as a typed failure', async () => {
    const { packageRoot } = await makeInstalled('0.1.0')
    const error = await runUpdate({
      currentVersion: '0.1.0',
      packageRoot,
      environment: unixEnvironment({ OCBOX_RELEASE_BASE: 'https://release.example.test' }),
      fetch: vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    }).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(OcboxError)
    expect((error as OcboxError).code).toBe('PROVIDER_UNAVAILABLE')
    expect((error as OcboxError).message).toBe('Could not reach the release source.')
  })

  it('does not inherit a developer OCBOX_VERSION pin', async () => {
    const previous = process.env['OCBOX_VERSION']
    process.env['OCBOX_VERSION'] = '9.9.9'
    try {
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
        expect(result.latestVersion).toBe('0.2.0')
      } finally {
        await mirror.close()
      }
    } finally {
      if (previous === undefined) delete process.env['OCBOX_VERSION']
      else process.env['OCBOX_VERSION'] = previous
    }
  })

  it('rejects a package directory that is not a global npm install', () => {
    expect(() => installedLayout(join(root, 'checkout', 'opencloudbox'))).toThrow(
      /can only replace an installed ocbox/,
    )
  })
})

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  engines: { node: string }
  version: string
}
const packageVersion = packageJson.version
const engineMatch = /(\d+)/.exec(packageJson.engines.node)
const engineMajor = engineMatch ? Number(engineMatch[1]) : 0

function canRun(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0
}

const hasSh = canRun('sh', ['-c', 'exit 0'])
const hasBash = canRun('bash', ['-c', 'exit 0'])
const hasPwsh = canRun('pwsh', ['-NoProfile', '-Command', 'exit 0'])
const hasWindowsPowerShell = canRun('powershell', ['-NoProfile', '-Command', 'exit 0'])
const powerShellCommands = [
  hasPwsh ? 'pwsh' : null,
  hasWindowsPowerShell ? 'powershell' : null,
].filter((command): command is string => command !== null)

const temporaryRoots: string[] = []

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })))
})

async function makeTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ocbox-install-test-'))
  temporaryRoots.push(root)
  return root
}

async function makeReleaseFixture(root: string): Promise<string> {
  const source = join(root, 'fixture-package')
  const release = join(root, 'release')
  await mkdir(join(source, 'bin'), { recursive: true })
  await mkdir(release, { recursive: true })
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'ocbox-install-fixture',
      version: packageVersion,
      bin: { ocbox: 'bin/ocbox.js' },
      files: ['bin'],
    }),
  )
  const bin = join(source, 'bin', 'ocbox.js')
  await writeFile(bin, `#!/usr/bin/env node\nconsole.log('${packageVersion}')\n`)
  await chmod(bin, 0o755)
  execFileSync(npmCommand, ['pack', '--pack-destination', release], {
    cwd: source,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  })
  const tarball = join(release, `ocbox-${packageVersion}.tgz`)
  await rename(join(release, `ocbox-install-fixture-${packageVersion}.tgz`), tarball)
  const hash = createHash('sha256')
    .update(await readFile(tarball))
    .digest('hex')
  await writeFile(join(release, 'SHA256SUMS'), `${hash}  ocbox-${packageVersion}.tgz\n`)
  return release
}

function unixInstallEnv(home: string, release: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    PATH: process.env['PATH'] ?? '',
    OCBOX_RELEASE_BASE: release,
    OCBOX_VERSION: packageVersion,
    npm_config_audit: 'false',
    npm_config_cache: join(home, '.npm-cache'),
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  }
}

describe('install script metadata', () => {
  it('pins the same minimum Node.js major as package.json engines', async () => {
    const shell = await readFile(join(repoRoot, 'install.sh'), 'utf8')
    const powerShell = await readFile(join(repoRoot, 'install.ps1'), 'utf8')
    const shellMatch = /^MIN_NODE_MAJOR=(\d+)$/m.exec(shell)
    const powerShellMatch = /^\$MinNodeMajor = (\d+)$/m.exec(powerShell)

    expect(engineMajor).toBeGreaterThan(0)
    expect(shellMatch).not.toBeNull()
    expect(powerShellMatch).not.toBeNull()
    expect(Number(shellMatch?.[1])).toBe(engineMajor)
    expect(Number(powerShellMatch?.[1])).toBe(engineMajor)
  })
})

describe('install.sh', () => {
  it.skipIf(!hasSh)('parses under POSIX sh', () => {
    const result = spawnSync('sh', ['-n', join(repoRoot, 'install.sh')], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  it.skipIf(!hasBash)('parses under bash', () => {
    const result = spawnSync('bash', ['-n', join(repoRoot, 'install.sh')], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  it.skipIf(process.platform === 'win32' || !hasSh)(
    'installs a verified tarball into a temporary prefix and prints its version',
    async () => {
      const root = await makeTemporaryRoot()
      const release = await makeReleaseFixture(root)
      const home = join(root, 'home')
      await mkdir(home, { recursive: true })

      const result = spawnSync('sh', [join(repoRoot, 'install.sh')], {
        encoding: 'utf8',
        env: unixInstallEnv(home, release),
        timeout: 120_000,
      })

      expect(result.status).toBe(0)
      const lines = result.stdout.trim().split(/\r?\n/)
      expect(lines.at(-1)).toBe(packageVersion)
      expect(lines).toContain(`export PATH="${join(home, '.ocbox', 'bin')}:$PATH"`)

      const installed = spawnSync(join(home, '.ocbox', 'bin', 'ocbox'), ['--version'], {
        encoding: 'utf8',
      })
      expect(installed.status).toBe(0)
      expect(installed.stdout.trim()).toBe(packageVersion)
    },
  )

  it.skipIf(process.platform === 'win32' || !hasSh)(
    'refuses a tampered checksum without installing',
    async () => {
      const root = await makeTemporaryRoot()
      const release = await makeReleaseFixture(root)
      const home = join(root, 'home')
      await mkdir(home, { recursive: true })
      await writeFile(
        join(release, 'SHA256SUMS'),
        `${'0'.repeat(64)}  ocbox-${packageVersion}.tgz\n`,
      )

      const result = spawnSync('sh', [join(repoRoot, 'install.sh')], {
        encoding: 'utf8',
        env: unixInstallEnv(home, release),
        timeout: 120_000,
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/checksum mismatch/i)
      expect(existsSync(join(home, '.ocbox', 'bin', 'ocbox'))).toBe(false)
    },
  )

  it.skipIf(process.platform === 'win32' || !hasSh)(
    'refuses a Node.js below the package engines minimum',
    async () => {
      const root = await makeTemporaryRoot()
      const release = await makeReleaseFixture(root)
      const fakeBin = join(root, 'fake-bin')
      const home = join(root, 'home')
      await mkdir(fakeBin, { recursive: true })
      await mkdir(home, { recursive: true })
      const fakeNode = join(fakeBin, 'node')
      await writeFile(fakeNode, `#!/bin/sh\necho v${Math.max(0, engineMajor - 1)}.0.0\n`)
      await chmod(fakeNode, 0o755)

      const env = unixInstallEnv(home, release)
      env['PATH'] = `${fakeBin}${delimiter}${env['PATH'] ?? ''}`
      const result = spawnSync('sh', [join(repoRoot, 'install.sh')], {
        encoding: 'utf8',
        env,
        timeout: 120_000,
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(`Node.js ${engineMajor} or newer is required`)
      expect(existsSync(join(home, '.ocbox', 'bin', 'ocbox'))).toBe(false)
    },
  )
})

describe('install.ps1', () => {
  it.skipIf(powerShellCommands.length === 0)('parses under PowerShell', () => {
    const script = join(repoRoot, 'install.ps1')
    const quoted = script.replace(/'/g, "''")
    const parse = `$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${quoted}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }`
    for (const command of powerShellCommands) {
      const result = spawnSync(command, ['-NoProfile', '-Command', parse], { encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
    }
  })

  for (const command of powerShellCommands) {
    it.skipIf(process.platform !== 'win32')(
      `installs a verified tarball and refuses a tampered checksum with ${command}`,
      async () => {
        const root = await makeTemporaryRoot()
        const localAppData = join(root, 'localappdata')
        const home = join(root, 'home')
        await mkdir(localAppData, { recursive: true })
        await mkdir(home, { recursive: true })
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: home,
          LOCALAPPDATA: localAppData,
          OCBOX_VERSION: packageVersion,
          npm_config_audit: 'false',
          npm_config_cache: join(root, '.npm-cache'),
          npm_config_fund: 'false',
          npm_config_update_notifier: 'false',
        }
        const originalUserPath = execFileSync(
          command,
          ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path', 'User')"],
          { encoding: 'utf8' },
        ).trim()

        try {
          const release = await makeReleaseFixture(root)
          env['OCBOX_RELEASE_BASE'] = release
          const installed = spawnSync(
            command,
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repoRoot, 'install.ps1')],
            { encoding: 'utf8', env, timeout: 120_000 },
          )
          expect(installed.status).toBe(0)
          expect(installed.stdout.trim().split(/\r?\n/).at(-1)).toBe(packageVersion)
          expect(existsSync(join(localAppData, 'ocbox', 'ocbox.cmd'))).toBe(true)
          const userPath = execFileSync(
            command,
            ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path', 'User')"],
            { encoding: 'utf8' },
          )
          expect(userPath).toContain(join(localAppData, 'ocbox'))

          await writeFile(
            join(release, 'SHA256SUMS'),
            `${'0'.repeat(64)}  ocbox-${packageVersion}.tgz\n`,
          )
          const tampered = spawnSync(
            command,
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repoRoot, 'install.ps1')],
            { encoding: 'utf8', env, timeout: 120_000 },
          )
          expect(tampered.status).not.toBe(0)
          expect(tampered.stderr).toMatch(/checksum mismatch/i)
        } finally {
          spawnSync(
            command,
            [
              '-NoProfile',
              '-Command',
              "[Environment]::SetEnvironmentVariable('Path', $env:OCBOX_TEST_ORIGINAL_USER_PATH, 'User')",
            ],
            {
              env: { ...process.env, OCBOX_TEST_ORIGINAL_USER_PATH: originalUserPath },
              stdio: 'ignore',
            },
          )
        }
      },
    )
  }
})

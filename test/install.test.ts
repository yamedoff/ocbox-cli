import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
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
  await writeFile(join(release, 'LATEST'), `${packageVersion}\n`)
  return release
}

interface ProcessResult {
  status: number | null
  stdout: string
  stderr: string
}

// The mirror runs in this process, so the install must run asynchronously; a
// blocking spawnSync would stop the server from answering the request.
function runProcess(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), options.timeout)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

interface HttpMirror {
  origin: string
  requests: string[]
  close: () => Promise<void>
}

async function makeHttpMirror(release: string): Promise<HttpMirror> {
  const requests: string[] = []
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url ?? '/')
    requests.push(path)
    const name = path.replace(/^\//, '')
    if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      response.statusCode = 404
      response.end()
      return
    }
    readFile(join(release, name)).then(
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
    throw new Error('the mirror did not bind a TCP port')
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
    'discovers the only local release tarball when OCBOX_VERSION is unset',
    async () => {
      const root = await makeTemporaryRoot()
      const release = await makeReleaseFixture(root)
      const home = join(root, 'home')
      await mkdir(home, { recursive: true })
      const env = unixInstallEnv(home, release)
      delete env['OCBOX_VERSION']

      const result = spawnSync('sh', [join(repoRoot, 'install.sh')], {
        encoding: 'utf8',
        env,
        timeout: 120_000,
      })

      expect(result.status).toBe(0)
      expect(result.stdout.trim().split(/\r?\n/).at(-1)).toBe(packageVersion)
    },
  )

  it.skipIf(process.platform === 'win32' || !hasSh)(
    'reads the release version from a non-default HTTP mirror when OCBOX_VERSION is unset',
    async () => {
      const root = await makeTemporaryRoot()
      const release = await makeReleaseFixture(root)
      await writeFile(join(release, 'LATEST'), `v${packageVersion}\n`)
      const home = join(root, 'home')
      await mkdir(home, { recursive: true })
      const mirror = await makeHttpMirror(release)

      try {
        const env = unixInstallEnv(home, mirror.origin)
        delete env['OCBOX_VERSION']
        const result = await runProcess('sh', [join(repoRoot, 'install.sh')], {
          env,
          timeout: 120_000,
        })

        expect(result.status).toBe(0)
        expect(result.stdout.trim().split(/\r?\n/).at(-1)).toBe(packageVersion)
        expect(mirror.requests).toContain('/LATEST')
        expect(mirror.requests).toContain(`/ocbox-${packageVersion}.tgz`)
      } finally {
        await mirror.close()
      }
    },
  )

  it.skipIf(process.platform === 'win32' || !hasSh)(
    'accepts a SHA256SUMS file with CRLF line endings',
    async () => {
      const root = await makeTemporaryRoot()
      const release = await makeReleaseFixture(root)
      const sums = await readFile(join(release, 'SHA256SUMS'), 'utf8')
      await writeFile(join(release, 'SHA256SUMS'), sums.replace(/\n/g, '\r\n'))
      const home = join(root, 'home')
      await mkdir(home, { recursive: true })

      const result = spawnSync('sh', [join(repoRoot, 'install.sh')], {
        encoding: 'utf8',
        env: unixInstallEnv(home, release),
        timeout: 120_000,
      })

      expect(result.status).toBe(0)
      expect(result.stdout.trim().split(/\r?\n/).at(-1)).toBe(packageVersion)
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
  it('keeps every exit inside the file-invocation branch', async () => {
    const script = await readFile(join(repoRoot, 'install.ps1'), 'utf8')
    const guard = /if\s*\(\s*\$isFileInvocation\s*\)\s*\{/.exec(script)
    expect(guard, 'install.ps1 has no file-invocation branch').not.toBeNull()

    const open = script.indexOf('{', guard?.index ?? 0)
    let depth = 0
    let close = -1
    for (let index = open; index < script.length; index += 1) {
      if (script[index] === '{') {
        depth += 1
      } else if (script[index] === '}') {
        depth -= 1
        if (depth === 0) {
          close = index
          break
        }
      }
    }
    expect(close, 'the file-invocation branch is not closed').toBeGreaterThan(open)

    const exits = [...script.matchAll(/\bexit\b/gi)].map((match) => match.index ?? -1)
    expect(exits.length).toBeGreaterThan(0)
    const lineOf = (index: number) => script.slice(0, index).split('\n').length
    const outside = exits.filter((index) => index < open || index > close).map(lineOf)
    expect(outside).toEqual([])
  })

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

  it.skipIf(!hasPwsh)(
    'reads the release version from a non-default HTTP mirror when OCBOX_VERSION is unset (PowerShell)',
    async () => {
      const root = await makeTemporaryRoot()
      const release = join(root, 'mirror')
      await mkdir(release, { recursive: true })
      await writeFile(join(release, 'LATEST'), `v${packageVersion}\n`)
      const mirror = await makeHttpMirror(release)
      const env: NodeJS.ProcessEnv = { ...process.env, OCBOX_RELEASE_BASE: mirror.origin }
      delete env['OCBOX_VERSION']

      try {
        const result = await runProcess(
          'pwsh',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repoRoot, 'install.ps1')],
          { env, timeout: 120_000 },
        )

        expect(result.status).not.toBe(0)
        expect(mirror.requests).toContain('/LATEST')
        expect(mirror.requests).toContain(`/ocbox-${packageVersion}.tgz`)
      } finally {
        await mirror.close()
      }
    },
  )

  it.skipIf(!hasPwsh)(
    'keeps the caller session alive when an irm | iex install fails',
    async () => {
      const root = await makeTemporaryRoot()
      const release = join(root, 'empty-release')
      await mkdir(release, { recursive: true })
      const script = await readFile(join(repoRoot, 'install.ps1'), 'utf8')
      const encoded = Buffer.from(script, 'utf8').toString('base64')
      const env: NodeJS.ProcessEnv = { ...process.env, OCBOX_RELEASE_BASE: release }
      delete env['OCBOX_VERSION']
      const command = [
        `$script = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encoded}'))`,
        '$before = $ErrorActionPreference',
        'Invoke-Expression $script',
        `[Console]::Out.WriteLine("session-alive errorActionPreference=$ErrorActionPreference before=$before")`,
      ].join('\n')

      const result = spawnSync('pwsh', ['-NoProfile', '-Command', command], {
        encoding: 'utf8',
        env,
        timeout: 120_000,
      })

      expect(result.stderr).toContain('ocbox install:')
      expect(result.stderr).toContain('No release tarball was found')
      expect(result.stdout).toMatch(/session-alive errorActionPreference=(\S+) before=\1/)
      expect(result.status).toBe(0)
    },
  )

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
          expect(
            installed.status,
            `stdout:\n${installed.stdout}\nstderr:\n${installed.stderr}`,
          ).toBe(0)
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

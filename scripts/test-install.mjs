#!/usr/bin/env node
/**
 * Exercises the real install scripts against the release files in dist/release,
 * then proves a corrupted tarball is refused with the checksum error.
 *
 * node scripts/test-install.mjs [--step=install|corrupt|all] [--release=<dir>]
 *
 * Every run uses a throwaway HOME/LOCALAPPDATA so the developer's own install
 * and npm cache are never touched. On Windows the user Path registry value is
 * captured first and restored afterwards.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const timeoutMilliseconds = 180_000
const checksumRefusal = /Checksum mismatch for ocbox-.*\.tgz\. Refusing to install\./i

function fail(message) {
  throw new Error(message)
}

function parseArguments(argv) {
  let step = 'all'
  let release = join(repoRoot, 'dist', 'release')

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--step' || argument.startsWith('--step=')) {
      let value = argument.slice('--step='.length)
      if (argument === '--step') {
        index += 1
        value = argv[index]
      }
      if (!['install', 'corrupt', 'all'].includes(value)) {
        fail(`invalid --step value ${JSON.stringify(value)}; use install, corrupt, or all`)
      }
      step = value
    } else if (argument === '--release' || argument.startsWith('--release=')) {
      let value = argument.slice('--release='.length)
      if (argument === '--release') {
        index += 1
        value = argv[index]
      }
      if (!value) fail('--release needs a directory')
      release = resolve(value)
    } else {
      fail(
        `unknown argument ${JSON.stringify(argument)}. ` +
          'Usage: node scripts/test-install.mjs [--step=install|corrupt|all] [--release=<dir>]',
      )
    }
  }

  return { step, release }
}

/**
 * Reads the release fixture and refuses to continue unless the tarball name
 * and SHA256SUMS agree with package.json and the tarball bytes.
 */
function loadRelease(releaseDir) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  assert.equal(typeof pkg.version, 'string', 'package.json has no version string')
  const version = pkg.version

  let entries
  try {
    entries = readdirSync(releaseDir)
  } catch {
    fail(`release directory ${releaseDir} was not found. Run \`pnpm run pack:release\` first.`)
  }

  const tarballs = entries.filter((name) => /^ocbox-.*\.tgz$/.test(name))
  if (tarballs.length === 0) {
    fail(`no ocbox-*.tgz was found in ${releaseDir}. Run \`pnpm run pack:release\` first.`)
  }
  if (tarballs.length > 1) {
    fail(`expected exactly one ocbox-*.tgz in ${releaseDir}, found ${tarballs.join(', ')}`)
  }

  const tarballName = tarballs[0]
  const expectedName = `ocbox-${version}.tgz`
  assert.equal(
    tarballName,
    expectedName,
    `release tarball ${tarballName} does not match package.json version ${version}`,
  )

  let sums
  try {
    sums = readFileSync(join(releaseDir, 'SHA256SUMS'), 'utf8')
  } catch {
    fail(`SHA256SUMS was not found in ${releaseDir}. Run \`pnpm run pack:release\` first.`)
  }

  let listed = null
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (match && match[2] === tarballName) {
      listed = match[1].toLowerCase()
      break
    }
  }
  assert.ok(listed, `SHA256SUMS in ${releaseDir} does not list ${tarballName}`)

  const actual = createHash('sha256')
    .update(readFileSync(join(releaseDir, tarballName)))
    .digest('hex')
  assert.equal(
    actual,
    listed,
    `the release fixture is corrupt: ${tarballName} does not match SHA256SUMS`,
  )

  return { version, tarballName, releaseDir }
}

async function makeSandbox() {
  let root
  try {
    root = await mkdtemp(join(homedir(), '.ocbox-install-test-'))
  } catch {
    root = await mkdtemp(join(tmpdir(), 'ocbox-install-test-'))
  }

  const sandbox = {
    root,
    home: join(root, 'home'),
    localappdata: join(root, 'localappdata'),
    tmp: join(root, 'tmp'),
    npmCache: join(root, 'npm-cache'),
    config: join(root, 'config'),
    state: join(root, 'state'),
    cache: join(root, 'cache'),
  }
  await Promise.all(
    Object.values(sandbox)
      .filter((value) => value !== root)
      .map((directory) => mkdir(directory, { recursive: true })),
  )
  return sandbox
}

function sandboxEnvironment(sandbox, releaseBase) {
  const env = { ...process.env }
  // A caller's OCBOX_VERSION would skip the local-folder discovery path.
  for (const name of Object.keys(env)) {
    if (name.toLowerCase() === 'ocbox_version') delete env[name]
  }
  return Object.assign(env, {
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    LOCALAPPDATA: sandbox.localappdata,
    XDG_CONFIG_HOME: sandbox.config,
    XDG_STATE_HOME: sandbox.state,
    XDG_CACHE_HOME: sandbox.cache,
    TMPDIR: sandbox.tmp,
    TEMP: sandbox.tmp,
    TMP: sandbox.tmp,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_cache: sandbox.npmCache,
    NO_COLOR: '1',
    OCBOX_RELEASE_BASE: releaseBase,
  })
}

function powerShellCommand() {
  for (const candidate of ['pwsh', 'powershell']) {
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', 'exit 0'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (probe.status === 0) return candidate
  }
  fail('PowerShell (pwsh or powershell) is required to run install.ps1')
}

function installerInvocation() {
  if (process.platform === 'win32') {
    return {
      command: powerShellCommand(),
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repoRoot, 'install.ps1')],
    }
  }
  return { command: 'sh', args: [join(repoRoot, 'install.sh')] }
}

function installedPath(sandbox) {
  return process.platform === 'win32'
    ? join(sandbox.localappdata, 'ocbox', 'ocbox.cmd')
    : join(sandbox.home, '.ocbox', 'bin', 'ocbox')
}

function runProcess(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments === true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMilliseconds)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.once('close', (status) => {
      clearTimeout(timer)
      resolvePromise({ status, stdout, stderr, timedOut })
    })
  })
}

function resultDetail(result) {
  const timeout = result.timedOut ? ' (timed out)' : ''
  return `exit ${result.status}${timeout}\nstdout:\n${result.stdout.trim()}\nstderr:\n${result.stderr.trim()}`
}

function lastNonEmptyLine(output) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return lines.at(-1) ?? ''
}

/**
 * oclif renders --version as "<package>/<version> <platform>-<arch> node-<version>",
 * so require the reported version token to equal package.json, not the whole line.
 */
function reportedVersion(output) {
  const line = lastNonEmptyLine(output)
  const token = line.split(/\s+/)[0] ?? ''
  return token.split('/').at(-1)?.replace(/^v/, '') ?? ''
}

function assertReportsVersion(output, context, version) {
  const line = lastNonEmptyLine(output)
  assert.notEqual(line, '', `${context} printed no version`)
  assert.equal(
    reportedVersion(output),
    version,
    `${context} reported ${JSON.stringify(line)}, expected version ${version}`,
  )
  return line
}

function runInstalled(commandPath, args, env) {
  if (process.platform === 'win32') {
    // cmd.exe /s strips the outer quote pair; keep the quoted command inside
    // that pair so a prefix path with spaces still runs the .cmd shim.
    const commandLine = `""${commandPath}" ${args.map((arg) => `"${arg}"`).join(' ')}"`
    return runProcess(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', commandLine], {
      env,
      windowsVerbatimArguments: true,
    })
  }
  return runProcess(commandPath, args, { env })
}

function normalizePath(value) {
  if (process.platform !== 'win32') return value
  const withoutPrefix = value.startsWith('\\\\?\\') ? value.slice(4) : value
  return withoutPrefix.toLowerCase()
}

function isInside(parent, child) {
  const base = normalizePath(parent)
  const target = normalizePath(child)
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

function readUserPath(powerShell) {
  const result = spawnSync(
    powerShell,
    ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path', 'User')"],
    { encoding: 'utf8', windowsHide: true },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    fail(`could not read the user Path: ${(result.stderr ?? '').trim()}`)
  }
  return (result.stdout ?? '').trim()
}

function restoreUserPath(powerShell, original) {
  const result = spawnSync(
    powerShell,
    [
      '-NoProfile',
      '-Command',
      "[Environment]::SetEnvironmentVariable('Path', $env:OCBOX_TEST_ORIGINAL_USER_PATH, 'User')",
    ],
    {
      env: { ...process.env, OCBOX_TEST_ORIGINAL_USER_PATH: original },
      encoding: 'utf8',
      windowsHide: true,
    },
  )
  if (result.status !== 0) {
    console.error(
      `install test failed: could not restore the user Path: ${(result.stderr ?? '').trim()}`,
    )
    process.exitCode = 1
  }
}

async function runInstallStep(release) {
  const sandbox = await makeSandbox()
  let powerShell = null
  let originalUserPath = null

  try {
    const env = sandboxEnvironment(sandbox, release.releaseDir)
    const installer = installerInvocation()
    if (process.platform === 'win32') {
      powerShell = installer.command
      originalUserPath = readUserPath(powerShell)
    }

    const installed = await runProcess(installer.command, installer.args, { env })
    assert.equal(installed.status, 0, `installer failed: ${resultDetail(installed)}`)
    assertReportsVersion(installed.stdout, 'installer', release.version)

    const commandPath = installedPath(sandbox)
    assert.ok(existsSync(commandPath), `installed command is missing at ${commandPath}`)

    const realInstalled = realpathSync(commandPath)
    const realUserHome = realpathSync(homedir())
    const realSandboxHome = realpathSync(sandbox.home)
    assert.ok(
      isInside(realUserHome, realInstalled) || isInside(realSandboxHome, realInstalled),
      `installed path ${realInstalled} is outside the user home ${realUserHome}`,
    )
    console.log(`install: installed path ${commandPath}`)

    const versionResult = await runInstalled(commandPath, ['--version'], env)
    assert.equal(versionResult.status, 0, `ocbox --version failed: ${resultDetail(versionResult)}`)
    const reported = reportedVersion(versionResult.stdout)
    assertReportsVersion(versionResult.stdout, 'ocbox --version', release.version)
    console.log(`install: version ${reported}`)

    const helpResult = await runInstalled(commandPath, ['--help'], env)
    assert.equal(helpResult.status, 0, `ocbox --help failed: ${resultDetail(helpResult)}`)
    assert.ok(
      helpResult.stdout.includes('USAGE'),
      `ocbox --help printed no USAGE: ${helpResult.stdout}`,
    )
    console.log('install: help ok')
  } finally {
    if (process.platform === 'win32' && powerShell !== null && originalUserPath !== null) {
      restoreUserPath(powerShell, originalUserPath)
    }
    await rm(sandbox.root, { recursive: true, force: true })
  }
}

async function runCorruptStep(release) {
  const sandbox = await makeSandbox()

  try {
    const corruptedRelease = join(sandbox.root, 'release')
    await cp(release.releaseDir, corruptedRelease, { recursive: true })

    const tarball = join(corruptedRelease, release.tarballName)
    const bytes = await readFile(tarball)
    bytes[Math.floor(bytes.length / 2)] ^= 0xff
    await writeFile(tarball, bytes)

    const env = sandboxEnvironment(sandbox, corruptedRelease)
    const installer = installerInvocation()
    const result = await runProcess(installer.command, installer.args, { env })

    assert.notEqual(result.status, 0, `corrupted tarball was accepted: ${resultDetail(result)}`)
    assert.match(
      result.stderr,
      checksumRefusal,
      `corrupted tarball was not refused with the checksum error: ${resultDetail(result)}`,
    )

    const commandPath = installedPath(sandbox)
    assert.ok(!existsSync(commandPath), `corrupted tarball installed a command at ${commandPath}`)

    const refusedLine = result.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => checksumRefusal.test(line))
    console.log(`corrupt: refused with ${refusedLine}`)
  } finally {
    await rm(sandbox.root, { recursive: true, force: true })
  }
}

try {
  const options = parseArguments(process.argv.slice(2))
  const release = loadRelease(options.release)
  const steps = options.step === 'all' ? ['install', 'corrupt'] : [options.step]

  if (steps.includes('install')) await runInstallStep(release)
  if (steps.includes('corrupt')) await runCorruptStep(release)

  console.log(`install test: passed (${steps.join(', ')})`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`install test failed: ${message}`)
  process.exitCode = 1
}

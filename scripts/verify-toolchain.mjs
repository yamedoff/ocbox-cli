import { spawnSync } from 'node:child_process'

const expected = {
  corepack: '0.36.0',
  node: 'v24.20.0',
  pnpm: '11.24.0',
}

function readVersion(command) {
  const result =
    process.platform === 'win32'
      ? spawnSync(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/s', '/c', `${command}.cmd --version`],
          {
            encoding: 'utf8',
          },
        )
      : spawnSync(command, ['--version'], { encoding: 'utf8' })

  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? 'unknown error'
    throw new Error(`${command} --version failed: ${detail}`)
  }

  return result.stdout.trim()
}

const actual = {
  corepack: readVersion('corepack'),
  node: process.version,
  pnpm: readVersion('pnpm'),
}

for (const [tool, version] of Object.entries(expected)) {
  if (actual[tool] !== version) {
    throw new Error(`Expected ${tool} ${version}, received ${actual[tool]}`)
  }
}

console.log(`Verified Node ${actual.node}, Corepack ${actual.corepack}, pnpm ${actual.pnpm}`)

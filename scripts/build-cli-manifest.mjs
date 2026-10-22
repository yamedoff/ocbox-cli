import assert from 'node:assert/strict'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config } from '@oclif/core'

// Cache command metadata after compilation so each installed CLI invocation
// imports its selected command rather than discovering every command module.
// Generate through oclif itself to preserve its metadata and module-path format.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const path = join(root, 'oclif.manifest.json')
// Never reuse the previous build's cache; same-version command changes must be
// rediscovered before packaging.
await rm(path, { force: true })
const config = await Config.load({ root, development: false })
const manifest = config.rootPlugin.manifest
assert(manifest && Object.keys(manifest.commands).length > 0, 'CLI commands must be discovered')
const files = await readdir(join(root, 'dist', 'commands'), { recursive: true })
assert.equal(
  Object.keys(manifest.commands).length,
  files.filter((file) => file.endsWith('.js')).length,
  'every compiled command must be included',
)
for (const command of Object.values(manifest.commands)) {
  assert(command.isESM === true, 'compiled command must be ESM')
  assert(
    Array.isArray(command.relativePath) &&
      command.relativePath[0] === 'dist' &&
      command.relativePath[1] === 'commands' &&
      command.relativePath.every((part) => typeof part === 'string' && !/[\\/]/.test(part)),
    'compiled command path required',
  )
}
await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)

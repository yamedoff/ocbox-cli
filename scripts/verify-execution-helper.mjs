import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const helperPath = fileURLToPath(new URL('../dist/execution-helper.js', import.meta.url))
const source = await readFile(helperPath, 'utf8')

// The helper is copied to its fixed image path without a sibling node_modules
// tree or shared chunks, so it must be a single self-contained bundle.
for (const specifier of ['zod', 'smol-toml', '@oclif/core']) {
  if (source.includes(`from "${specifier}"`)) {
    throw new Error(
      `Packaged execution helper still imports ${specifier}; it must be self-contained`,
    )
  }
}
if (/from\s+"\.\/chunk-/.test(source)) {
  throw new Error('Packaged execution helper depends on shared chunks; it must be a single file')
}

const probe = spawnSync(process.execPath, [helperPath, '--protocol-version'], {
  encoding: 'utf8',
  shell: false,
  windowsHide: true,
})

if (probe.error !== undefined) throw probe.error
if (probe.status !== 0 || probe.signal !== null || probe.stdout !== '1\n' || probe.stderr !== '') {
  throw new Error('Packaged execution helper did not report protocol version 1 cleanly')
}

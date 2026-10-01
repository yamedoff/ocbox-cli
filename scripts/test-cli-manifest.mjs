import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = await mkdtemp(join(tmpdir(), 'ocbox-manifest-'))
try {
  // Exercise the standalone package layout used by npm and the base image.
  // An unrelated command deliberately throws on import. A working build cache
  // must load auth:logout directly without executing that command at startup.
  await cp(join(root, 'dist'), join(directory, 'dist'), { recursive: true })
  await cp(join(root, 'package.json'), join(directory, 'package.json'))
  await cp(join(root, 'oclif.manifest.json'), join(directory, 'oclif.manifest.json'))
  const poison = 'UNSELECTED_COMMAND_IMPORTED'
  await writeFile(
    join(directory, 'dist', 'commands', 'agent', 'doctor.js'),
    `throw new Error('${poison}')\n`,
  )
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [join(directory, 'dist', 'index.js'), 'auth', 'logout', '--help'],
    { cwd: directory, timeout: 30_000, windowsHide: true },
  )
  assert(stdout.includes('USAGE'), 'selected command must render its help')
  assert(!stderr.includes(poison), 'startup must not import unrelated commands')
  console.log('CLI manifest lazy command loading passed')
} finally {
  await rm(directory, { recursive: true, force: true })
}

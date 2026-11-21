import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dir = join(root, 'dist', 'release')

rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', '--pack-destination', dir],
  {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
)

const name = `ocbox-${pkg.version}.tgz`
renameSync(join(dir, `${pkg.name}-${pkg.version}.tgz`), join(dir, name))

const hash = createHash('sha256')
  .update(readFileSync(join(dir, name)))
  .digest('hex')
writeFileSync(join(dir, 'SHA256SUMS'), `${hash}  ${name}\n`)
writeFileSync(join(dir, 'LATEST'), `${pkg.version}\n`)

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const helperPath = fileURLToPath(new URL('../dist/execution-helper.js', import.meta.url))
const probe = spawnSync(process.execPath, [helperPath, '--protocol-version'], {
  encoding: 'utf8',
  shell: false,
  windowsHide: true,
})

if (probe.error !== undefined) throw probe.error
if (probe.status !== 0 || probe.signal !== null || probe.stdout !== '1\n' || probe.stderr !== '') {
  throw new Error('Packaged execution helper did not report protocol version 1 cleanly')
}

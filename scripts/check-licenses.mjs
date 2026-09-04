import { spawnSync } from 'node:child_process'

const result =
  process.platform === 'win32'
    ? spawnSync(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', 'pnpm.cmd licenses list --json'],
        { encoding: 'utf8' },
      )
    : spawnSync('pnpm', ['licenses', 'list', '--json'], { encoding: 'utf8' })

if (result.status !== 0) {
  const detail = result.error?.message ?? result.stderr?.trim() ?? 'unknown error'
  throw new Error(`Unable to read dependency licenses: ${detail}`)
}

const output = result.stdout.trim()
const report = output === 'No licenses in packages found' ? {} : JSON.parse(output)
const licenses = Array.isArray(report)
  ? report.map((entry) => String(entry.license ?? 'UNKNOWN'))
  : Object.keys(report)
const denied = /(?:AGPL|GPL|LGPL|SSPL|BUSL|Commons Clause|CC-BY-NC)/i
const unknown = /^(?:UNKNOWN|UNLICENSED)$/i
const rejected = licenses.filter((license) => denied.test(license) || unknown.test(license))

if (rejected.length > 0) {
  throw new Error(`Rejected dependency license metadata: ${rejected.join(', ')}`)
}

console.log(`Reviewed ${licenses.length} dependency license group(s)`)

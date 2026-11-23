import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadIgnoreRuleGroups } from '/workspace/wt/a18-s-rv2-128/.review-base/src/sync/ignore-rules.ts'
import { scanSourceManifest } from '/workspace/wt/a18-s-rv2-128/.review-base/src/sync/manifest.ts'

const root = await mkdtemp(join(tmpdir(), 'ocb-case-base-'))
await writeFile(join(root, '.gitignore'), 'A.txt\nTmp\n')
await writeFile(join(root, 'A.txt'), 'x')
await writeFile(join(root, 'a.txt'), 'x')
await mkdir(join(root, 'Tmp'))
await writeFile(join(root, 'Tmp', 'out.txt'), 'x')
await mkdir(join(root, 'tmp'))
await writeFile(join(root, 'tmp', 'out.txt'), 'x')

execFileSync('git', ['init', '-q'], { cwd: root })
execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: root })
execFileSync('git', ['config', 'user.name', 'a'], { cwd: root })

const gitVisible = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter((line) => line.length > 0)
  .sort()

const groups = await loadIgnoreRuleGroups(root, [])
const manifest = await scanSourceManifest(root, { ignoreRuleGroups: groups })
const cliVisible = manifest.entries
  .filter((entry) => entry.type === 'file' && entry.exclusionReason === null)
  .map((entry) => entry.path)
  .sort()

console.log('BASE git keeps :', gitVisible.join(', '))
console.log('BASE CLI keeps :', cliVisible.join(', '))
const dropped = gitVisible.filter((path) => !cliVisible.includes(path))
console.log('BASE CLI drops but git keeps:', dropped.join(', ') || '(none)')
await rm(root, { force: true, recursive: true })

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

async function fakeCli(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ocbox-measure-cli-'))
  directories.push(directory)
  const path = join(directory, 'fake-cli.mjs')
  await writeFile(
    path,
    `await new Promise((resolve) => setTimeout(resolve, 5))
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  kind: 'result',
  outcome: 'remote_result',
  result: {
    exitCode: 0,
    signal: null,
    startedAt: '2026-11-09T00:00:00.000Z',
    completedAt: '2026-11-09T00:00:00.000Z',
  },
}) + '\\n')
`,
    'utf8',
  )
  return path
}

describe('CLI latency measurement', () => {
  it('runs the same command repeatedly and prints added-time p50/p95', async () => {
    const cli = await fakeCli()
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        join(root, 'scripts', 'measure-cli-latency.mjs'),
        '--runs=3',
        '--cli',
        cli,
        '--format=json',
        '--',
        'true',
      ],
      { cwd: root },
    )
    const summary = JSON.parse(stdout.trim()) as {
      addedMs: { p50: number; p95: number }
      cliWallMs: { p50: number; p95: number }
      failures: number
      productWindowMs: { p50: number; p95: number }
      runs: number
    }
    expect(summary.runs).toBe(3)
    expect(summary.failures).toBe(0)
    expect(summary.productWindowMs.p50).toBe(0)
    expect(summary.addedMs.p50).toBeGreaterThan(0)
    expect(summary.addedMs.p95).toBeGreaterThanOrEqual(summary.addedMs.p50)
    expect(summary.cliWallMs.p95).toBeGreaterThanOrEqual(summary.cliWallMs.p50)
  })
})

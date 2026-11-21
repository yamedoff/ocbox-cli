#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function usage() {
  return `Usage: node scripts/measure-cli-latency.mjs [options] [-- <command> [args...]]

Runs the same \`ocbox exec --json\` command repeatedly and reports the CLI's
added time over the product's own execution window:
  added = CLI wall time - (result.completedAt - result.startedAt)

Options:
  --runs <n>       Number of runs (default 10)
  --cli <path>     CLI entry point (default: dist/index.js, or OCBOX_BIN)
  --session <id>   Session to execute in (default: the selected Session)
  --format <mode>  "text" (default) or "json"
  --help           Show this help

The remote command defaults to \`true\`. No token or credential is printed.`
}

function parseArguments(argv) {
  const options = {
    cli: process.env['OCBOX_BIN'] ?? join(root, 'dist', 'index.js'),
    command: [],
    format: 'text',
    runs: 10,
    session: undefined,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') {
      options.command = argv.slice(index + 1)
      break
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    if (argument === '--runs' || argument.startsWith('--runs=')) {
      const value = argument.includes('=') ? argument.split('=')[1] : argv[++index]
      options.runs = Number(value)
      continue
    }
    if (argument === '--cli' || argument.startsWith('--cli=')) {
      options.cli = argument.includes('=') ? argument.split('=')[1] : argv[++index]
      continue
    }
    if (argument === '--session' || argument.startsWith('--session=')) {
      options.session = argument.includes('=') ? argument.split('=')[1] : argv[++index]
      continue
    }
    if (argument === '--format' || argument.startsWith('--format=')) {
      options.format = argument.includes('=') ? argument.split('=')[1] : argv[++index]
      continue
    }
    options.command.push(argument)
  }
  if (options.command.length === 0) options.command = ['true']
  return options
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.ceil((percentileValue / 100) * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index]
}

function round(value) {
  return value === null ? null : Math.round(value * 10) / 10
}

function resultOf(stdout) {
  const lines = stdout.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim()
    if (line === undefined || line.length === 0) continue
    try {
      const envelope = JSON.parse(line)
      if (envelope?.kind === 'result' && envelope.result !== undefined) return envelope.result
    } catch {
      // A command may print JSON-looking output; only a result envelope counts.
    }
  }
  return null
}

function runOnce(options) {
  return new Promise((resolveRun, rejectRun) => {
    const started = performance.now()
    const arguments_ = [
      options.cli,
      'exec',
      '--json',
      ...(options.session === undefined ? [] : ['--session', options.session]),
      '--',
      ...options.command,
    ]
    const child = spawn(process.execPath, arguments_, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', rejectRun)
    child.once('close', (exitCode) => {
      resolveRun({
        exitCode: exitCode ?? 1,
        stderr,
        stdout,
        wallMilliseconds: performance.now() - started,
      })
    })
  })
}

function summarise(values) {
  return { p50: round(percentile(values, 50)), p95: round(percentile(values, 95)) }
}

const options = parseArguments(process.argv.slice(2))
if (options.help === true) {
  process.stdout.write(`${usage()}\n`)
  process.exit(0)
}
if (!Number.isInteger(options.runs) || options.runs < 1) {
  process.stderr.write('--runs must be a positive integer\n')
  process.exit(2)
}
if (!['text', 'json'].includes(options.format)) {
  process.stderr.write('--format must be "text" or "json"\n')
  process.exit(2)
}
if (!existsSync(options.cli)) {
  process.stderr.write(`CLI entry point not found: ${options.cli}\nRun pnpm build first.\n`)
  process.exit(2)
}

const runs = []
let failures = 0
for (let index = 0; index < options.runs; index += 1) {
  const run = await runOnce(options)
  const result = resultOf(run.stdout)
  const startedAt = result === null ? Number.NaN : Date.parse(result.startedAt)
  const completedAt = result === null ? Number.NaN : Date.parse(result.completedAt)
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) {
    failures += 1
    if (options.format === 'text') {
      process.stderr.write(
        `run ${index + 1}: no result envelope (exit ${run.exitCode})\n${run.stderr}`,
      )
    }
    continue
  }
  const productWindowMilliseconds = completedAt - startedAt
  runs.push({
    addedMilliseconds: run.wallMilliseconds - productWindowMilliseconds,
    cliWallMilliseconds: run.wallMilliseconds,
    exitCode: run.exitCode,
    productWindowMilliseconds,
  })
  if (options.format === 'text') {
    process.stdout.write(
      `run ${index + 1}: cli=${Math.round(run.wallMilliseconds)}ms ` +
        `product=${productWindowMilliseconds}ms ` +
        `added=${Math.round(run.wallMilliseconds - productWindowMilliseconds)}ms ` +
        `exit=${run.exitCode}\n`,
    )
  }
}

const summary = {
  addedMs: summarise(runs.map((run) => run.addedMilliseconds)),
  cliWallMs: summarise(runs.map((run) => run.cliWallMilliseconds)),
  command: options.command,
  failures,
  productWindowMs: summarise(runs.map((run) => run.productWindowMilliseconds)),
  runs: runs.length,
}
if (options.format === 'json') {
  process.stdout.write(`${JSON.stringify(summary)}\n`)
} else {
  process.stdout.write(
    `added over API: p50=${summary.addedMs.p50}ms p95=${summary.addedMs.p95}ms ` +
      `(n=${summary.runs}, failures=${summary.failures})\n`,
  )
  process.stdout.write(`cli wall: p50=${summary.cliWallMs.p50}ms p95=${summary.cliWallMs.p95}ms\n`)
  process.stdout.write(
    `product window: p50=${summary.productWindowMs.p50}ms ` +
      `p95=${summary.productWindowMs.p95}ms\n`,
  )
}
process.exit(failures > 0 || runs.length === 0 ? 1 : 0)

#!/usr/bin/env node

import { installHttpTrace, trace } from './cli/trace.js'

// `performance.now()` counts from process start, so this is the entry phase.
// It is the first statement of the main module; everything before it is Node
// bootstrap and this small trace module.
trace.phase('entry')

// The fetch wrapper is installed before the API URL is known; this mutable
// origin is filled after the startup modules load and before the version gate.
// Requests outside it are printed as `:external` and never expose a URL.
let tracedApiOrigin: string | undefined
installHttpTrace(trace, {
  isApiUrl: (url) => tracedApiOrigin !== undefined && url.origin === tracedApiOrigin,
})

// The startup modules are loaded here rather than through static imports so
// their cost is one measured phase instead of being spent before entry.
const moduleLoadStarted = trace.enabled ? performance.now() : undefined
const oclif: typeof import('@oclif/core') & { default?: typeof import('@oclif/core') } =
  await import('@oclif/core')
const { runStartupVersionGate } = await import('./version/startup.js')
const { apiUrlFromArgv } = await import('./version/gate.js')
try {
  tracedApiOrigin = new URL(apiUrlFromArgv(process.argv.slice(2))).origin
} catch {
  tracedApiOrigin = undefined
}
// The bundler inlines @oclif/core's CommonJS build as a default export; a
// native ESM import exposes the same names directly. Accept both shapes.
const execute = oclif.execute ?? oclif.default?.execute
if (execute === undefined) throw new Error('@oclif/core did not export execute')
if (moduleLoadStarted !== undefined) {
  trace.phase('module-load', { durationMs: performance.now() - moduleLoadStarted })
}

// Windows has no standard SHELL variable. Without one, oclif synchronously
// queries the parent process through PowerShell/WMI without a deadline, which
// can stall even noninteractive auth commands. Use Windows' configured command
// interpreter for shell metadata, while honoring an explicitly configured SHELL.
// Product execution still uses its existing structured argv/provider boundary.
if (process.platform === 'win32' && process.env['SHELL'] === undefined) {
  process.env['SHELL'] = (process.env['COMSPEC'] ?? process.env['ComSpec'] ?? 'cmd.exe')
    .split(/[\\/]/)
    .at(-1)
}

// The version gate runs once per real invocation, before any command work.
// Informational surfaces never contact the API, and a failed or absent meta
// answer leaves the gate open. Local commands still print the notice; only
// commands that reach the hosted API fail, through the authenticated transport.
await runStartupVersionGate(process.argv.slice(2))

// oclif owns argument parsing and the built-in help/version surface. Product
// commands will be registered in later milestones.
const commandStarted = trace.enabled ? performance.now() : undefined
let commandPhaseWritten = false
const writeCommandPhase = (): void => {
  if (commandPhaseWritten || commandStarted === undefined) return
  commandPhaseWritten = true
  trace.phase('command', { durationMs: performance.now() - commandStarted })
}
// oclif's error handler can call `process.exit` before `execute` settles; the
// exit listener keeps the command phase line on that path too.
if (commandStarted !== undefined) process.once('exit', writeCommandPhase)
try {
  await execute({
    development: false,
    dir: import.meta.url,
  })
} finally {
  writeCommandPhase()
  if (commandStarted !== undefined) process.removeListener('exit', writeCommandPhase)
}

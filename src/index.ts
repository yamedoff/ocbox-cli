#!/usr/bin/env node

import { execute } from '@oclif/core'
import { runStartupVersionGate } from './version/startup.js'

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
await execute({
  development: false,
  dir: import.meta.url,
})

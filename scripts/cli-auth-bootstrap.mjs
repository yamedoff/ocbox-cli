import { pathToFileURL } from 'node:url'

// Harness-only phase marker before importing the bundled CLI. Preserve the
// argv layout of `node dist/index.js ...` so oclif sees the actual entry point.
// Do not report argv, paths, environment, or authorization material.
process.argv.splice(1, 1)
process.stderr.write('Auth CLI: bootstrap\n')
await import(pathToFileURL(process.argv[1]).href)

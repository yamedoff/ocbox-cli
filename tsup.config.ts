import { defineConfig } from 'tsup'

export default defineConfig({
  banner: {
    // @oclif/core ships CommonJS. When it is inlined into an ESM bundle its
    // runtime `require` calls (for example `require('url')`) need a real
    // CommonJS require rooted at this module.
    js: "import { createRequire as __ocboxCreateRequire } from 'node:module';\nconst require = __ocboxCreateRequire(import.meta.url);",
  },
  clean: true,
  dts: true,
  entry: {
    'commands/agent/index': 'src/commands/agent/index.ts',
    'commands/agent/setup': 'src/commands/agent/setup.ts',
    'commands/agent/doctor': 'src/commands/agent/doctor.ts',
    'commands/agent/hook': 'src/commands/agent/hook.ts',
    'commands/agent/remove': 'src/commands/agent/remove.ts',
    'commands/auth/index': 'src/commands/auth/index.ts',
    'commands/auth/login': 'src/commands/auth/login.ts',
    'commands/auth/logout': 'src/commands/auth/logout.ts',
    'commands/auth/status': 'src/commands/auth/status.ts',
    'commands/destroy': 'src/commands/destroy.ts',
    'commands/exec': 'src/commands/exec.ts',
    'commands/init': 'src/commands/init.ts',
    'commands/ls': 'src/commands/ls.ts',
    'commands/pause': 'src/commands/pause.ts',
    'commands/providers': 'src/commands/providers.ts',
    'commands/start': 'src/commands/start.ts',
    'commands/status': 'src/commands/status.ts',
    'commands/stop': 'src/commands/stop.ts',
    'commands/sync/diff': 'src/commands/sync/diff.ts',
    'commands/sync/index': 'src/commands/sync/index.ts',
    'commands/sync/pull': 'src/commands/sync/pull.ts',
    'commands/sync/push': 'src/commands/sync/push.ts',
    'commands/sync/recover': 'src/commands/sync/recover.ts',
    'commands/use': 'src/commands/use.ts',
    contracts: 'src/contracts.ts',
    index: 'src/index.ts',
    infrastructure: 'src/infrastructure.ts',
  },
  format: ['esm'],
  // The CLI is copied into the base image without a node_modules tree, so every
  // production dependency must be inlined. Shared output chunks keep one copy of
  // @oclif/core across the entry points. The execution helper is built
  // separately by tsup.helper.config.ts as a single self-contained file.
  // TypeScript stays external: oclif only loads it for dev-mode ts paths, and
  // inlining it would add ~10 MiB to the compiled CLI.
  external: ['typescript'],
  noExternal: ['@oclif/core', 'smol-toml', 'zod'],
  outDir: 'dist',
  platform: 'node',
  sourcemap: true,
  target: 'node24',
})

import { defineConfig } from 'tsup'

// The execution helper is installed at the fixed image path
// /opt/ocbox/bin/ocbox-exec-helper.js without a sibling node_modules tree or
// shared chunks, so it must be a single self-contained ESM file. It is built
// after the main tsup.config.ts pass and overwrites only that entry file.
export default defineConfig({
  banner: {
    js: "import { createRequire as __ocboxCreateRequire } from 'node:module';\nconst require = __ocboxCreateRequire(import.meta.url);",
  },
  clean: false,
  dts: false,
  entry: { 'execution-helper': 'src/execution/helper-main.ts' },
  format: ['esm'],
  noExternal: [/.*/],
  outDir: 'dist',
  platform: 'node',
  sourcemap: true,
  splitting: false,
  target: 'node24',
})

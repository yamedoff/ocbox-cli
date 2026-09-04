import { defineConfig } from 'tsup'

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    contracts: 'src/contracts.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  sourcemap: true,
  target: 'node24',
})

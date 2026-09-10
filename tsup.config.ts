import { defineConfig } from 'tsup'

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    'commands/destroy': 'src/commands/destroy.ts',
    'commands/init': 'src/commands/init.ts',
    'commands/ls': 'src/commands/ls.ts',
    'commands/pause': 'src/commands/pause.ts',
    'commands/providers': 'src/commands/providers.ts',
    'commands/start': 'src/commands/start.ts',
    'commands/status': 'src/commands/status.ts',
    'commands/stop': 'src/commands/stop.ts',
    'commands/use': 'src/commands/use.ts',
    contracts: 'src/contracts.ts',
    'execution-helper': 'src/execution/helper-main.ts',
    index: 'src/index.ts',
    infrastructure: 'src/infrastructure.ts',
  },
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  sourcemap: true,
  target: 'node24',
})

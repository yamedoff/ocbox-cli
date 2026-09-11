import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    include: ['test/**/*.test.ts'],
    // Interactive tests run 8-12 sequential filesystem (lock/store/scan)
    // operations. A fixed 5s per-test budget tripped under parallel worker
    // load on Windows, so multi-op suites need a roomier machine-agnostic
    // ceiling; real hangs still surface through liveness-sensitive locks.
    testTimeout: 30_000,
  },
})

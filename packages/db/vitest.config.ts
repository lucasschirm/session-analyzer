import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Pipeline/perf tests exercise a real in-memory SQLite pipeline end to
    // end; the default 5s test / 10s hook timeouts are too tight on CI
    // runners, where WASM SQLite init and fixture setup in beforeAll hooks
    // run slower than on a dev machine.
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // v8 coverage follows dist sourcemaps back to workspace dependencies'
      // TS source (db-core, sync-core, transformer), which otherwise leaks
      // their coverage into this package's numbers even though each has its
      // own dedicated test:coverage run.
      exclude: ['**/db-core/**', '**/sync-core/**', '**/transformer/**'],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 60,
        statements: 60,
      },
    },
  },
});

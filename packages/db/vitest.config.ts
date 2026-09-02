import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Pipeline/perf tests exercise a real in-memory SQLite pipeline end to
    // end; the default 5s timeout is too tight once this suite runs
    // alongside the other 7 packages' suites under CI parallelism.
    testTimeout: 30000,
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

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/unit/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/main.ts',
        'src/types/**',
        // Thin worker glue exercised end-to-end by the Playwright suite.
        'src/db/db-worker.ts',
        'src/db/analytics-worker.ts',
        // Pure type-only protocol files with no runtime code to cover.
        'src/db/db-protocol.ts',
        'src/db/analytics-protocol.ts',
        'src/sync/sync-protocol.ts',
        'src/lib/uploaded-file.ts',
      ],
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

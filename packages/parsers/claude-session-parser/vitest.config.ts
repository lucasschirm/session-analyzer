import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        // Type-only modules: no executable statements worth measuring
        // (same exclusion the site package uses).
        'src/types/**',
      ],
      reporter: ['text', 'html'],
      // Package-wide coverage target. All eight coverage-improvement chunks
      // (see docs/superpowers/specs coverage plan) have landed; measured
      // coverage is 99.19% statements / 95.91% branches / 100% functions /
      // 99.38% lines, comfortably above this floor.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});

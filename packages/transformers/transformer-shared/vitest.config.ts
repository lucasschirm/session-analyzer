import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // src/conformance/{suite,fixtures/index}.ts are test infrastructure
      // consumed by every transformer plugin package (claude-transformer
      // today), not production logic this package exercises itself. Their
      // real branch coverage comes from each plugin's own
      // tests/unit/conformance.test.ts driving the suite against rich
      // harness-specific fixtures (e.g. claude-transformer's 9 fixtures
      // covering complete/subagent/redacted/malformed/replayed/
      // classification scenarios) — that coverage is attributed to the
      // consuming package's own report, not this one's. This package's own
      // tests/unit/base-contract-conformance.test.ts still exercises the
      // suite directly to prove the DS-B1 (#139) base-contract regression
      // fix, just without claiming full branch coverage here.
      exclude: ['src/conformance/suite.ts', 'src/conformance/fixtures/index.ts'],
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

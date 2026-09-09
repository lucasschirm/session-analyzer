# tests/unit/

Unit tests for the harness-agnostic `@lucasschirm/sal-transformer-shared`
package.

## Files

- **base-contract-conformance.test.ts** — Runs the shared conformance suite
  against a minimal fixture transformer implementing only the base
  `ScalarMetricValue` contract (no Claude-only extended fields), guarding
  against the DS-B1 (#139) regression where the suite assumed every
  transformer extends `ScalarMetricValue`.
- **comparability.test.ts** — Tests comparability group and metric identity
  semantics.
- **contract.test.ts** — Tests the transformer contract and registry
  integration.
- **invariants.test.ts** — Tests the canonical invariant definitions.
- **registry.test.ts** — Tests the transformer registry and detection
  heuristics.

Claude Code-specific unit tests (`claude-code*.test.ts`,
`conformance.test.ts`) live in
`packages/transformers/claude-transformer/tests/unit/`, not here.

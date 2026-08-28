# tests/unit/

Unit tests for the `@lucasschirm/sal-transformer` package.

## Files

- **claude-code.test.ts** — Integration tests for `ClaudeCodeTransformer` transform, classification, and session shape.
- **claude-code-metrics.test.ts** — Tests metric value derivation, anti-double-counting, and unavailable reason handling.
- **claude-code-tasks.test.ts** — Tests task-derived evidence records (file operations, commands, validations, normalized events).
- **claude-code-usage.test.ts** — Tests model usage, capabilities, pricing, invocations, payloads, permissions, and hooks.
- **comparability.test.ts** — Tests comparability group and metric identity semantics.
- **conformance.test.ts** — Runs the shared `tests/conformance/suite.ts` against `ClaudeCodeTransformer` and checks each golden fixture.
- **contract.test.ts** — Tests the transformer contract and registry integration.
- **invariants.test.ts** — Tests the canonical invariant definitions.
- **registry.test.ts** — Tests the transformer registry and detection heuristics.

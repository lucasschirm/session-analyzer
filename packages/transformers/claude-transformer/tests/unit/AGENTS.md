# tests/unit/

Unit tests for the `@lucasschirm/sal-claude-transformer` package.

## Files

- **claude-code.test.ts** — Integration tests for `ClaudeCodeTransformer` transform, classification, and session shape.
- **claude-code-attribution-metrics.test.ts** — Tests attribution metric derivation and allocation methods.
- **claude-code-metrics.test.ts** — Tests metric value derivation, anti-double-counting, and unavailable reason handling.
- **claude-code-optimization-metrics.test.ts** — Tests optimization metric derivation.
- **claude-code-tasks.test.ts** — Tests task-derived evidence records (file operations, commands, validations, normalized events).
- **claude-code-usage.test.ts** — Tests model usage, capabilities, pricing, invocations, payloads, permissions, and hooks.
- **conformance.test.ts** — Runs the shared conformance suite
  (`@lucasschirm/sal-transformer-shared/conformance`) against
  `ClaudeCodeTransformer` and checks each golden fixture in
  `../conformance/fixtures/`.

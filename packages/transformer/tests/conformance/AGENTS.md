# tests/conformance/

Shared conformance harness and golden fixtures used to verify that any `SessionTransformer` (including `ClaudeCodeTransformer`) obeys the 10 canonical invariants.

## Files

- **suite.ts** — `runTransformerConformanceSuite` entry point; executes all 10 invariants against a transformer and fixture set and returns a pass/partial/fail report.
- **fixtures/index.ts** — `ClaudeCodeTransformer` golden fixtures and a typed `TransformerFixtures` contract for reuse by future plugins.
- **fixtures/data/replayed.jsonl** — A tiny synthetic transcript that repeats source events to exercise deterministic deduplication.

## Key relationships

- `suite.ts` imports fixtures from `fixtures/index.ts` and is driven by `tests/unit/conformance.test.ts`.

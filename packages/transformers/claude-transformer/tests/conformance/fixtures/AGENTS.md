# tests/conformance/fixtures/

Golden fixture data for `ClaudeCodeTransformer`, built against the generic
`ConformanceFixture`/`TransformerFixtures` contract types imported from
`@lucasschirm/sal-transformer-shared`.

## Files

- **index.ts** — Loads parser fixtures and builds Claude-specific bundles covering complete, malformed, partial, redacted, compacted, replayed, classification, capability-matrix, and effort scenarios.
- **data/replayed.jsonl** — Synthetic transcript that replays the same assistant event twice to test deduplication invariants.
- **data/effort-multi-tier.jsonl** — Added for #289 (per-message reasoning-effort capture). Synthetic root-only transcript with three assistant entries whose raw `effort` values are `high`, `high`, `xhigh` (one transition, in `requestOrder` order), used to conformance-check that `effort`/`normalizedEffort` round-trip through `model_request` evidence payloads and to exercise the `claude:effort:changes:*` metric's n=3/one-transition scenario.

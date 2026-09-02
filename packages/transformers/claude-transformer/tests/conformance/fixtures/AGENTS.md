# tests/conformance/fixtures/

Golden fixture data for `ClaudeCodeTransformer`, built against the generic
`ConformanceFixture`/`TransformerFixtures` contract types imported from
`@lucasschirm/sal-transformer-shared`.

## Files

- **index.ts** — Loads parser fixtures and builds Claude-specific bundles covering complete, malformed, partial, redacted, compacted, replayed, classification, and capability-matrix scenarios.
- **data/replayed.jsonl** — Synthetic transcript that replays the same assistant event twice to test deduplication invariants.

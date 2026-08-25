# tests/conformance/fixtures/

Golden fixture data and the `TransformerFixtures` contract for the shared conformance suite.

## Files

- **index.ts** — Loads parser fixtures and builds Claude-specific bundles covering complete, malformed, partial, redacted, compacted, replayed, classification, and capability-matrix scenarios.
- **data/replayed.jsonl** — Synthetic transcript that replays the same assistant event twice to test deduplication invariants.

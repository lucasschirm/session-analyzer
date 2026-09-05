# `@lucasschirm/sal-claude-transformer`

Claude Code session transformer plugin for the Session Analyzer analytics
platform.

## Purpose

`claude-transformer` implements `SessionTransformer<ArtifactBundle>` (from
`@lucasschirm/sal-transformer-shared`) for Claude Code sessions. It receives
typed native parser output from `@lucasschirm/sal-claude-session-parser`,
classifies artifacts, normalizes evidence, derives Phase 1–3 metrics, and
produces a canonical write batch — all without opening SQLite, querying
project history, accessing remote storage, or emitting project lifecycle
events.

The package is **pure and deterministic**: the same bundle and versions
always produce the same output. All generated identifiers are deterministic
from stable source identity, not call order or wall-clock time.

## Claude Code transformer

`src/plugin/claude-code.ts` implements `SessionTransformer<ArtifactBundle>` for
Claude Code sessions and is split into focused modules:

| Module | Responsibility |
|--------|----------------|
| `claude-code.ts` | Main transformer: detection, classification, transform orchestration |
| `claude-code-usage.ts` | Token usage, model requests, invocations, payloads, permissions, modes, hooks |
| `claude-code-metrics.ts` | Phase 1 metric derivation, anti-double-counting, unavailable reasons |
| `claude-code-optimization-metrics.ts` | Optimization metric derivation |
| `claude-code-attribution-metrics.ts` | Attribution metric derivation and allocation methods |
| `claude-code-tasks.ts` | Tasks, validations, file operations, commands, normalized events |
| `metric-labels.ts` | Metric ID -> label lookup, built from an injected set of `MetricDefinition`s |

These files are internally cross-referential (they moved as one atomic unit
from `packages/transformer`) and depend on
`@lucasschirm/sal-transformer-shared` for every contract type
(`UnknownArtifactBundle`, `TransformContext`, `NormalizedEvidenceRecord`,
`Provenance`, `MetricCapability`, `MetricUnavailableReason`,
`MetricDefinition`, comparability helpers, `SessionTransformer`, etc.) —
there is no `../bundle.js`-style relative import into a sibling package.

Classification uses normalized full paths and structured content per the
plan's artifact classification table (`.claude/skills/<name>/SKILL.md` →
Skill, `.claude/agents/*.md` → Agent, `.claude/rules/**` → Rule, `.mcp.json` →
MCP configuration, etc.). A structured artifact can yield multiple component
definitions, each with a source pointer.

## Metric labels

`src/plugin/metric-labels.ts` exports `createMetricLabelLookup(definitions)`,
a factory that accepts a `MetricDefinition[]` and returns a
`{ tryMetricIdToLabel, metricIdToLabel }` pair — this is the shared,
harness-agnostic building block (any future transformer plugin package can
build its own label lookup from its own definitions without depending on
Claude-specific getters).

This package's own `tryMetricIdToLabel`/`metricIdToLabel` exports are built
from the combined Claude metric definitions (`getClaudeCodeMetricDefinitions()`
+ `getClaudeCodeOptimizationMetricDefinitions()` +
`getClaudeCodeAttributionMetricDefinitions()`). Including the attribution
definitions fixes DS-B3 (#141), which previously omitted them and caused
attribution metric IDs to render raw in site chart helpers.

## Conformance suite

This package drives the shared conformance suite
(`@lucasschirm/sal-transformer-shared/conformance`,
`runTransformerConformanceSuite`) against `ClaudeCodeTransformer` and its own
golden fixtures in `tests/conformance/fixtures/` from
`tests/unit/conformance.test.ts`. Golden fixtures include root sessions, Sub
Agent sessions, malformed/partial/redacted/compacted artifacts, and a
synthetic replayed transcript (`fixtures/data/replayed.jsonl`) that exercises
deterministic deduplication. See
`packages/transformers/transformer-shared/README.md` for the 10 canonical
invariants the suite verifies.

## Public API

The package exports from `src/index.ts`:

- **Claude Code plugin**: `ClaudeCodeTransformer`.
- **Metric derivation**: `getClaudeCodeMetricDefinitions`,
  `getClaudeCodeOptimizationMetricDefinitions`,
  `getClaudeCodeAttributionMetricDefinitions`, `ClaudeMetricValue`,
  `ClaudeMetricsResult`, `MetricProvenance`.
- **Metric labels**: `createMetricLabelLookup`, `tryMetricIdToLabel`,
  `metricIdToLabel`.
- Task/usage evidence normalization helpers used internally by
  `ClaudeCodeTransformer` (also exported for direct testing).

Contract types (`SessionTransformer`, `TransformResult`,
`UnknownArtifactBundle`, `MetricDefinition`, etc.) are re-exported from
`@lucasschirm/sal-transformer-shared`, not duplicated here.

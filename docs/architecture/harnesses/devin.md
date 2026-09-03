# Devin CLI Harness

This document describes the Devin CLI harness integration for the Session
Analyzer analytics platform, covering the native artifact bundle, parser,
transformer, metrics, and known limitations.

## Plugin and parser

| Layer | Package / module |
|-------|-----------------|
| Transformer plugin | `DevinTransformer` in `packages/transformers/devin-transformer/src/devin-transformer.ts` |
| Parser | `@lucasschirm/sal-devin-session-parser` (`packages/parsers/devin-session-parser/`) |
| Sync plugin | `@lucasschirm/devin-session-sync` (`packages/plugins/devin-session-sync/`) |
| Harness ID | `devin` |

## Native artifact bundle

A Devin CLI session is delivered as a manifest bundle with the following
conventional artifacts:

| Relative path | Role | Classification |
|---------------|------|----------------|
| `transcript.jsonl` | Root transcript | `transcript` |
| `native/atif-transcript.json` | Native ATIF transcript | `transcript` (role `native`) |
| `native/models.json` | Model pricing/settings | `settings/runtime` (role `models`) |
| `native/schema-descriptor.json` | Schema metadata | `settings/runtime` (role `schema`) |
| `native/models-list.raw.json` | Raw model dump | `settings/runtime` (role `models-raw`) |
| `plans/plan-<id>.md` | Plan transcript | `transcript` (role `plan`) |
| `.devin/config.json`, `config.json` | Workspace/global settings | `settings` |

The parser reads `devin-session-jsonl/v1` lines, `ATIF v1.7` native
transcripts, and the `models.json` file. It does not depend on SQLite or any
analytics package, so it can be reused outside the platform.

## Transformer pipeline

`DevinTransformer.transform` performs the following steps:

1. **Artifact classification** — maps each artifact to a canonical kind and role
   using path conventions and schema-validated content.
2. **Bundle parsing** — extracts the session line, ordered messages, ATIF steps,
   tool calls, and model list from `transcript.jsonl` and the native ATIF file.
3. **Evidence normalization** — builds the session spine, tool invocation
   records, and token usage records with stable record IDs derived from source
   identity.
4. **Metric derivation** — produces `MetricValue` records for each Phase 1
   metric and a matching capability declaration.
5. **Unavailable reasons** — any metric that cannot be derived from the bundle
   receives an explicit `unavailableReason` rather than a silent zero.

## Metrics

Phase 1 emits comparability groups for the dimensions and scopes listed below.
All metrics are `observed` where the source data is exact, `derived` where the
value is computed from timestamps, and `unavailable` where the source data is
missing.

| Metric family | Phase 1 metrics | Unit | Notes |
|---------------|-----------------|------|-------|
| Tokens | `devin:tokens:{prompt,completion,cached,total}:{root_only,inclusive}` | `token` | Exact when ATIF `final_metrics` or `response_dimensions` are present; otherwise unavailable |
| Steps | `devin:steps:count:{root_only,inclusive}` | `count` | Derived from ATIF step list or message ordering |
| Turns | `devin:turns:count:{root_only,inclusive}` | `count` | Derived from ordered messages |
| Tool invocations | `devin:invocations:tool:{root_only,inclusive}` | `count` | From ACP `tool_call_json.kind = edit|execute|search` |
| Skill invocations | `devin:invocations:skill:{root_only,inclusive}` | `count` | Unavailable in Phase 1 (requires `plugins/discovered.json` parsing) |
| Agent invocations | `devin:invocations:agent:{root_only,inclusive}` | `count` | Unavailable in Phase 1 (requires `plugins/discovered.json` parsing) |
| Duration | `devin:duration:wall_ms:{root_only,inclusive}` | `ms` | Derived from session start/end or ATIF step timestamps |
| Cost | `devin:cost:total:{root_only,inclusive}` | `cents` | Unavailable in Phase 1 (requires `models.json` pricing and the `sessions.model` -> `model_uid` join planned for DS-F4) |

All metrics follow the same comparability rules as Claude Code metrics and are
covered by the same `MetricDefinition` contract. Unknown is never represented as
zero; every missing metric is flagged with an `unavailableReason`.

## Portfolio and session visibility

Devin sessions are visible in the portfolio overview as soon as a manifest is
ingested:

- `PortfolioOverview.sessionCount` and `harnessCount` include devin sessions.
- `PortfolioOverview.headlineMetrics` surfaces additive devin metrics (e.g.
  `devin:tokens:total:inclusive`) from the portfolio daily rollups.
- `PortfolioTrends` contains per-day devin metric points.
- `ProjectList` and `ModelHarnessCohorts` expose the `devin` harness with
  `sessionCount` and sample-size tokens.
- `SessionEvidenceSummary` returns the session's devin headline metrics with
  per-session sample sizes.

## Known limitations

- **Skill and Agent metrics**: ACP currently only reports generic `edit`,
  `execute`, and `search` tool kinds. Skill/Agent invocations require follow-on
  parser work to consume `plugins/discovered.json` or equivalent metadata.
- **Cost**: Devin ATIF does not include provider-observed cost. Computing
  per-session cost requires the `sessions.model` -> `models.json`
  `variants[].model_uid` join planned for DS-F4.
- **Timestamp source**: `message_nodes.created_at` is unreliable in the observed
  schema, so wall-clock duration is derived from session start/end or ATIF step
  timestamps, not per-message.
- **Token population**: Devin ATIF `final_metrics` are session-level totals, not
  per-request provider usage, so they are a different observation unit from
  Claude per-request token classes.

## Testing

- Conformance fixtures: `packages/transformers/devin-transformer/tests/conformance/fixtures/`
- Pipeline integration test: `packages/db/tests/pipeline/pipe-013-devin-ingest.test.ts`
- Unit test coverage: `packages/db/tests/unit/ingestion.test.ts` and
  `packages/db/tests/unit/ingestion-to-portfolio.test.ts`

# Metrics Architecture

Metric registry, definition model, extension guides, and cross-harness
comparability for the Session Analyzer analytics platform.

## Overview

The metric system is built on a versioned registry of typed metric definitions.
Each definition records the full meaning of a metric — not just its name — so
that values from different harnesses, transformer versions, or statistical
policies can be safely compared or explicitly separated. Metrics are never
calculated in UI code; they are derived deterministically inside transformer
plugins and precomputed into rollup tables during ingestion.

## Metric definition model

Every metric is defined by a `MetricDefinition` record (see plan §9) with at
least:

| Field | Purpose |
|-------|---------|
| `metricId` | Stable canonical identifier |
| `version` | Meaning version — changes when formula/denominator/inclusion changes |
| `label` / `description` | Human-readable name and explanation |
| `family` | Metric grouping (e.g. `tokens`, `cost`, `time`, `invocations`) |
| `measurementClass` | `observed`, `derived`, `estimated`, or `heuristic` |
| `unit` / `valueType` | Unit string and value type (`integer`, `real`, `currency`, `ratio`, `text`) |
| `grain` | Entity grain (e.g. `session`, `request`, `invocation`) |
| `dimensions` | Filterable dimensions |
| `denominator` | Optional denominator metric for ratio metrics |
| `populationRule` / `statusRule` | Eligibility and status/censoring rules |
| `aggregation` | How values aggregate (sum, mean, max, non-additive, etc.) |
| `allocationMethod` | Optional Phase 3 attribution/allocation method |
| `statisticalPolicyId` | Statistical policy reference |
| `comparabilityGroupInputs` | Properties used to derive `comparability_group_id` |
| `missingDataBehavior` | `unknown` or `not_applicable` |
| `rootInclusion` | `root_only`, `inclusive`, `both`, or `not_applicable` |
| `distributionPolicy` | Optional distribution/percentile policy |
| `provenanceRequirement` | Required provenance level |

## Versioning rules

Changing any of the following creates a **new definition version**:

- Formula or computation method
- Denominator
- Inclusion rule (root-only vs inclusive)
- Measurement class
- Allocation method
- Statistical policy
- Population or status rules

Historical values retain their original version. Label-only corrections may
update documentation without changing meaning, but registry checksums still
detect drift.

## Cross-harness comparability

A canonical metric can be combined across transformers only when these
properties are compatible:

- Metric ID and definition version
- Unit, currency/pricing version, grain, and dimensions
- Denominator, observation unit, population, and session-finality rules
- Measurement class and native mapping version
- Root-only/inclusive semantics
- Status, threshold, censoring, and missing-data rules
- Aggregation, statistical, and attribution/allocation method

The registry derives a machine-readable `comparability_group_id` from these
properties. Values, distributions, contributions, rollups, cohorts, and chart
series are keyed by that group and **cannot aggregate mixed groups**.

Capabilities are `available`, `partial`, `unavailable`, or `incompatible`.
Dashboards show eligible `N`, known `n`, unknown count, and coverage. Default
portfolio headlines stratify incompatible groups by harness/method instead of
combining them.

An exact provider token value is never silently combined with an estimated
text-token value. Native metrics may use a namespaced ID
(`native.claude_code.<metric>`) until a canonical definition and explicit bridge
mapping exist.

## Storage

Metric definitions and values are stored in `db-core` (`src/metrics.ts`):

| Table | Purpose |
|-------|---------|
| `metric_definitions` | Immutable versioned meaning, dimension schema, compatibility group, statistical policy, allocation method |
| `transformer_metric_capabilities` | Support and reason by transformer/harness/version |
| `metric_values` | Typed numeric/integer/text representation, grain entity, dimensions key, class, confidence, root scope, definition/comparability version, unavailable reason |
| `metric_distributions` | Definition/comparability/statistical-policy key, eligible N, known n, unknown count, sum, min, max, mean, p50/p75/p90/p95, dispersion, outlier rule |
| `metric_provenance` | Source artifact/event/field and estimation/allocation method |
| `statistical_policies` | Observation unit, eligibility, weighting, percentile algorithm/minimums, ratio policy, censoring, outliers, uncertainty, timezone/day boundary |
| `attribution_policies` | Phase 3 window boundaries, overlap handling, allocation, confidence, additive status |
| `native_metric_values` | Namespaced values not yet canonicalized |
| `heuristic_metric_values` | Separately versioned future semantic results and evidence |

## Extension guide: adding a new metric

1. Update `docs/superpowers/SESSION_METRICS.md` or a linked proposal.
2. Define class, unit, grain, dimensions, denominator, provenance, availability,
   confidence, aggregation, and missing behavior.
3. Verify whether current normalized evidence is sufficient.
4. Add/version the registry entry in `db-core` metric definitions.
5. Update relevant transformer capabilities (`transformer_metric_capabilities`).
6. Implement deterministic computation in the transformer plugin — never in UI
   code.
7. Add typed storage only when scalar/distribution storage is insufficient.
8. Implement rollup contribution and replacement behavior in `db`.
9. Add anti-double-counting and reconciliation tests.
10. Expose a data-source DTO/series only for a real consumer.
11. Add accessible presentation and evidence drill-down.
12. Document reprocessing requirements and compatibility.

A generated metric release matrix maps every Phase 1–3 metric and insight recipe
to required evidence, class, additive/non-additive behavior, capability gate,
statistical/attribution policy, and release readiness. Broad phase labels do
not override metric-level gates. Deterministic variants of insight recipes ship
before heuristic variants.

## Phase scope

| Phase | Scope |
|-------|-------|
| Phase 1 | Exact core metrics (tokens, cost, time, invocations, file ops, commands) |
| Phase 2 | Deterministic optimization metrics (context growth, compaction, cache efficiency) |
| Phase 3 | Improved attribution (model/pricing registries, Sub Agent critical path, overlap allocation) |
| Phase 4 | Semantic/causal analysis — separately versioned, not part of initial release |

## References

- Plan: `docs/superpowers/plans/2026-08-24-analytics-data-platform-design.md` §9 (Metric definition and evolution), §8.6 (Metric registry and values schema)
- ADR-0006: Metric versioning
- Metric ontology: `docs/superpowers/SESSION_METRICS.md`
- Implementation: `packages/db-core/src/metrics.ts`, `packages/transformer/src/metric.ts`, `packages/transformer/src/comparability.ts`

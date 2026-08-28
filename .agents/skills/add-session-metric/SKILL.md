---
name: add-session-metric
description: Use when defining, implementing, versioning, or reprocessing a session-level or aggregate metric for the analytics data platform. Covers definition metadata, evidence sufficiency, storage/rollup decision tree, implementation, dashboard exposure, versioning, and reprocessing requirements.
---

# Add Session Metric

## Overview

This skill codifies the repeatable procedure for adding a new metric to the
analytics platform. A metric is a versioned definition with deterministic
computation, typed storage, rollup contribution behavior, dashboard exposure,
and explicit reprocessing requirements. Metrics are never calculated in UI
code; they are computed by transformers and stored by `db`.

**Core invariants:**
- Unknown is not zero.
- Exact and estimated values remain separable.
- Changing a formula, denominator, inclusion rule, measurement class, or
  allocation method creates a new definition version. Historical values retain
  their version.
- Canonical metrics are never calculated in Lit components.

## Plan references

- §9 Metric definition and evolution
- §8.6 Metric registry and values (schema)
- §6.2 Cross-harness comparability
- §10.3 Atomic generation replacement (contribution behavior)
- §10.4 Reprocessing
- §15.1 db-core acceptance (rollup reconciliation)
- §15.2 Transformer acceptance (metric formulas)
- §16.3 Rules — metric meaning changes require versioning; aggregates expose
  sample size and evidence

## Package paths

| Concern | Path |
|---|---|
| Metric definitions type | `packages/db-core/src/metrics.ts` |
| Metric computation (transformer) | `packages/transformer/src/metric.ts` |
| Comparability groups | `packages/transformer/src/comparability.ts` |
| Metric values store | `packages/db-core/src/metrics.ts` |
| Rollup contributions | `packages/db-core/src/schema.ts` |
| Analytics data source (DTOs) | `packages/db/src/dto.ts` |
| Analytics data source (queries) | `packages/db/src/analytics.ts` |
| Metric registry docs | `docs/architecture/metrics/` |
| Metric ontology spec | `docs/superpowers/SESSION_METRICS.md` |

## Procedure

### Step 1 — Update the metric ontology

Update `docs/superpowers/SESSION_METRICS.md` or a linked proposal with the new
metric definition. Document:

- metric ID and label;
- family;
- measurement class (`observed`, `derived`, `estimated`, `heuristic`);
- unit and value type;
- grain and dimensions;
- denominator (if any);
- population rule and status rule;
- aggregation method;
- allocation method (if any);
- statistical policy;
- comparability group inputs;
- missing data behavior;
- root inclusion semantics;
- distribution policy (if any);
- provenance requirement.

### Step 2 — Create the registry entry

Add a `MetricDefinition` entry in the metric registry. Use this template:

```ts
// packages/db-core/src/metrics.ts (or generated registry source)
const <metricId>_v<version>: MetricDefinition = {
  metricId: '<metricId>',
  version: 1,
  label: '<Human Label>',
  description: '<One-sentence description of what this metric measures>',
  family: '<family>',
  measurementClass: 'observed', // | 'derived' | 'estimated' | 'heuristic'
  unit: '<unit>',
  valueType: 'integer', // | 'real' | 'currency' | 'ratio' | 'text'
  grain: '<grain>',
  dimensions: ['<dim1>', '<dim2>'],
  denominator: '<denominatorMetricId>', // optional
  populationRule: '<which sessions are eligible>',
  statusRule: '<how status is determined>',
  aggregation: '<sum|mean|distribution|non-additive>',
  allocationMethod: '<method>', // optional, for attribution metrics
  statisticalPolicyId: '<policyId>',
  comparabilityGroupInputs: [
    'metricId', 'definitionVersion', 'unit', 'grain', 'dimensions',
    'denominator', 'observationUnit', 'population', 'sessionFinalityRules',
    'measurementClass', 'nativeMappingVersion', 'rootOnlyInclusiveSemantics',
    'statusThresholdCensoringMissingDataRules',
    'aggregationStatisticalAttributionMethod',
  ],
  missingDataBehavior: 'unknown', // | 'not_applicable'
  rootInclusion: 'root_only', // | 'inclusive' | 'both' | 'not_applicable'
  distributionPolicy: '<policyId>', // optional
  provenanceRequirement: '<what evidence is required>',
};
```

**Command to verify registry integrity:**

```bash
cd packages/db-core && pnpm vitest run -- -t "metric.*registry"
```

### Step 3 — Verify evidence sufficiency

Check whether current normalized evidence is sufficient to compute this
metric. For each required evidence field, trace it to a source table in
`packages/db-core/src/session-evidence.ts`.

```bash
# Search for evidence fields the metric depends on
cd packages/db-core && grep -rn '<evidenceField>' src/session-evidence.ts
```

If evidence is insufficient:
1. Determine whether the transformer can derive it from existing native
   artifacts.
2. If not, document the gap as an unavailable capability with a reason.
3. If new evidence fields are needed, follow the `add-db-migration` skill to
   add them to the schema.

### Step 4 — Storage and rollup decision tree

Use this decision tree to determine storage requirements:

```
Is the metric scalar and per-session?
├── YES → store in metric_values (typed numeric/integer/text representation)
│         Is it additive across sessions?
│         ├── YES → add rollup_contributions entry (root-only or inclusive namespace)
│         │         Add project_daily_rollups / portfolio_daily_rollups bucket
│         │         Add project_dimension_rollups / portfolio_dimension_rollups if dimension-filtered
│         └── NO → store in metric_distributions (eligible N, known n, unknown count,
│                   sum, min, max, mean, p50/p75/p90/p95, dispersion, outlier rule)
│
├── Is it a distribution?
│   ├── YES → store in metric_distributions and project_distributions / portfolio_distributions
│   │         Recompute affected buckets at write time, not read time
│   └── NO → continue
│
├── Is it a cohort comparison?
│   ├── YES → store in comparison_cohorts and comparison_cohort_members
│   └── NO → continue
│
└── Is it a chart series?
    ├── YES → store in session_chart_series (bounded precomputed series)
    └── NO → typed summary table only if frequently filtered; otherwise metric_values
```

**Key rules:**
- Root-only and inclusive contributions use **separate namespaces** in
  `rollup_contributions`. Child sessions never contribute again to inclusive
  portfolio totals.
- Distributions are recomputed at write time for affected bounded cohorts from
  indexed current session contributions.
- The system does not precompute arbitrary dimension combinations. A versioned
  `rollup_policy` defines supported dimensions, cardinality caps, top-N/other
  behavior, unknown buckets, and analysis release.

### Step 5 — Implement computation in the transformer

Implement deterministic computation in the transformer, never in UI code.

```ts
// packages/transformer/src/plugin/<harness>/metric-<metricId>.ts
import type { TransformResult } from '../../session';
import type { MetricValue } from '../../metric';

export function compute<metricId>(
  evidence: NormalizedEvidence,
  context: TransformContext,
): MetricValue | undefined {
  // 1. Check capability — if evidence is insufficient, return undefined
  //    and declare 'unavailable' or 'partial' with a reason.
  // 2. Compute the value deterministically.
  // 3. Attach provenance (source artifact/event/field).
  // 4. Set root scope (root_only, inclusive, or not_applicable).
  // 5. Set measurement class and confidence.
  // 6. Return typed MetricValue.
}
```

**Command to test computation:**

```bash
cd packages/transformer && pnpm vitest run -- -t "<metricId>"
```

### Step 6 — Update transformer capabilities

For each harness transformer, update `getCapabilities()` to declare support
for the new metric:

```ts
getCapabilities(bundle?): MetricCapability[] {
  return [
    // ...existing capabilities...
    { metricId: '<metricId>', status: 'available' },
    // or: { metricId: '<metricId>', status: 'unavailable', reason: '<reason>' },
  ];
}
```

### Step 7 — Implement rollup contribution and replacement behavior

If the metric is additive, implement its rollup contribution in `db`:

```ts
// packages/db/src/ingestion.ts (or dedicated contribution module)
// During atomic generation replacement:
// 1. Subtract previous-generation contributions for affected sessions.
// 2. Apply new root-only contributions through the root-only namespace.
// 3. Apply new inclusive contributions through the inclusive namespace.
// 4. Rebuild affected distributions and chart buckets.
```

If the metric is non-additive (e.g., a ratio, percentile, or distribution),
implement affected-bucket rebuild logic in `db`:

```ts
// Rebuild affected distributions from indexed current session contributions
// under the selected analysis release.
```

**Command to test rollup reconciliation:**

```bash
cd packages/db && pnpm vitest run -- -t "rollup.*reconcil"
cd packages/db-core && pnpm vitest run -- -t "contribution"
```

### Step 8 — Add anti-double-counting and reconciliation tests

```ts
// packages/transformer/tests/<harness>-<metricId>.test.ts
describe('<metricId> anti-double-counting', () => {
  it('root-only value does not include descendant contributions', () => {
    // Transform a root session with child sessions.
    // Assert root-only metric value excludes child values.
  });

  it('inclusive value includes descendants but children do not contribute again', () => {
    // Transform root + children.
    // Assert inclusive value = root + children.
    // Assert children's contributions are not separately added to portfolio total.
  });
});

// packages/db-core/tests/<metricId>-reconciliation.test.ts
describe('<metricId> rollup reconciliation', () => {
  it('project rollup equals sum of current session contributions', () => {
    // Ingest sessions, then assert project rollup matches contributions.
  });

  it('replacement subtracts old and adds new contributions', () => {
    // Ingest, re-ingest with changed data, assert rollup reflects new values.
  });
});
```

**Command:**

```bash
cd packages/transformer && pnpm vitest run -- -t "<metricId>.*double"
cd packages/db-core && pnpm vitest run -- -t "<metricId>.*reconcil"
```

### Step 9 — Expose a data-source DTO/series (only for a real consumer)

If a dashboard view needs this metric, add a DTO in `packages/db/src/dto.ts`
and a query method in `packages/db/src/analytics.ts`. Do not add DTOs for
speculative consumers.

**DTO template:**

```ts
// packages/db/src/dto.ts
export interface <metricId>Dto {
  metricId: string;
  metricVersion: number;
  comparabilityGroupId: string;
  label: string;
  value: number | null;
  measurementClass: string;
  confidence: string | null;
  eligibleN: number;
  knownN: number;
  unknownCount: number;
  coverage: number;
  unavailableReason: string | null;
  evidenceLinks: readonly EvidenceLink[];
  analysisReleaseId: string;
  generationToken: string;
}
```

DTOs must carry: analysis release and generation tokens, comparability group,
eligible `N`, known `n`, unknown count, coverage, measurement class,
confidence, metric version, and evidence links. UI components never import SQL
types or calculate canonical metrics.

### Step 10 — Add accessible presentation and evidence drill-down

If the metric appears on a dashboard, ensure:
- a chart component receives the series DTO (no SQL or metric formulas in the
  component);
- every chart has keyboard interaction, a textual summary, a tabular
  fallback, color-independent status encoding, and loading/empty/partial/error
  states;
- evidence drill-down links resolve to paginated evidence queries.

Follow the `add-analytics-view` skill for full view implementation.

### Step 11 — Document reprocessing requirements and compatibility

Document in `docs/architecture/metrics/<metricId>.md`:

- which evidence fields are required;
- which transformer version first produces this metric;
- whether reprocessing requires retained blobs or source reacquisition;
- compatibility notes (can this metric be combined across harnesses?);
- the comparability group ID and what it means.

**Reprocessing behavior:** If sources are unavailable, existing metrics
remain readable in their prior analysis release. Portfolio/project aggregates
select one compatible release or show separate strata; they never silently
mix versions.

### Step 12 — Versioning

If you are changing an existing metric's meaning (formula, denominator,
inclusion rule, measurement class, or allocation method):

1. Create a new version of the `MetricDefinition` (increment `version`).
2. Historical values retain their old version.
3. Update the comparability group inputs if the change affects comparability.
4. Reprocessed sessions produce values under the new version.
5. Dashboards show eligible `N`, known `n`, unknown count, and coverage;
   default portfolio headlines stratify incompatible groups by harness/method
   instead of combining them.

Label-only corrections may update documentation without changing meaning, but
registry checksums still detect drift.

## Completion checklist

- [ ] Metric ontology updated in `SESSION_METRICS.md` or linked proposal.
- [ ] `MetricDefinition` entry added to the registry with all required fields.
- [ ] Evidence sufficiency verified; gaps documented as unavailable capabilities.
- [ ] Storage/rollup decision tree applied; appropriate tables identified.
- [ ] Deterministic computation implemented in the transformer (not in UI).
- [ ] Transformer capabilities updated for each harness.
- [ ] Rollup contribution and replacement behavior implemented (if additive).
- [ ] Affected-bucket distribution rebuild implemented (if non-additive).
- [ ] Anti-double-counting tests pass.
- [ ] Rollup reconciliation tests pass.
- [ ] DTO exposed only if a real consumer exists; DTO carries all required fields.
- [ ] Accessible presentation and evidence drill-down added (if dashboarded).
- [ ] Reprocessing requirements documented in `docs/architecture/metrics/`.
- [ ] Versioning applied if changing an existing metric's meaning.
- [ ] `pnpm --filter @lucasschirm/sal-transformer verify` passes.
- [ ] `pnpm --filter @lucasschirm/sal-db-core verify` passes.
- [ ] `pnpm --filter @lucasschirm/sal-db verify` passes.

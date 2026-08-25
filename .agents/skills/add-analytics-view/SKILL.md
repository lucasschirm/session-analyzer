---
name: add-analytics-view
description: Use when adding or updating a dashboard view in the analytics platform. Covers data-source DTOs, chart/table accessibility, filters, stable routes, evidence links, and read-performance verification for Portfolio, Project Behavior, Session Evidence, Component Ecosystem, and Artifact Diff views.
---

# Add Analytics View

## Overview

This skill codifies the repeatable procedure for adding or updating a
dashboard view that consumes the `AnalyticsDataSource` contract. The site is
one consumer of analytics behavior, not its owner. UI components never import
SQL types or calculate canonical metrics. Every chart has keyboard
interaction, a textual summary, a tabular fallback, and evidence links.

**Core invariants:**
- UI components never import SQL types or calculate canonical metrics.
- Opening a session performs no transcript scan, tree reconstruction,
  percentile calculation, metric derivation, configuration diff, or
  project-wide aggregation.
- Project and portfolio pages use rollups and bounded indexed series.
- DTOs carry analysis release and generation tokens, comparability group,
  eligible `N`, known `n`, unknown count, coverage, measurement class,
  confidence, metric version, and evidence links.
- Cursor pagination is snapshot-consistent against the generation token.

## Plan references

- §11 Read contract and dashboards (§11.1 AnalyticsDataSource, §11.2
  navigation, §11.3 views, §11.4 charts, §11.5 read-performance rule)
- §8.7 Precomputed summaries and rollups
- §15.4 Site and end-to-end acceptance criteria
- §15.5 Performance acceptance criteria
- §16.3 Rules — canonical metrics are never calculated in Lit components;
  DTO packages contain no runtime database implementation types

## Package paths

| Concern | Path |
|---|---|
| AnalyticsDataSource interface | `packages/db/src/analytics.ts` |
| DTOs | `packages/db/src/dto.ts` |
| Site data-source client | `packages/site/src/db/` |
| Lit pages | `packages/site/src/pages/` |
| Lit components | `packages/site/src/components/` |
| Router | `packages/site/src/router.ts` |
| Site WASM/OPFS adapter | `packages/site/src/db/` |
| E2E tests | `packages/site/tests/e2e/` |
| Unit tests | `packages/site/tests/unit/` |

## Procedure

### Step 1 — Identify the view and its data-source methods

Determine which view you are adding or updating:

| View | Plan §11.3 | Data-source methods |
|---|---|---|
| Portfolio | §11.3 | portfolio overview, trends, component utilization, model/harness cohorts, project list |
| Project Behavior | §11.3 | project behavior summary, session trend series, configuration timeline, outliers, comparisons |
| SessionEvidence | §11.3 | session evidence summary, context/timing series, root-child breakdown, component facts, validation, evidence pages |
| ComponentEcosystem | §11.3 | component ecosystem summary, versions, scopes, utilization, distributions, projects/sessions, lifecycle comparisons |
| ArtifactDiff | §11.3 | artifact version metadata, safe unified/side-by-side diff |

Also consider cross-cutting methods: paginated transcript/evidence retrieval,
project session list/search/sort, root/child session trees, filter metadata,
and capability/coverage explanations.

### Step 2 — Define the data-source DTOs

Add or update DTOs in `packages/db/src/dto.ts`. DTOs must be browser/
server-neutral and contain no runtime database implementation types.

**DTO template:**

```ts
// packages/db/src/dto.ts

export interface <ViewName>SummaryDto {
  analysisReleaseId: string;
  generationToken: string;
  comparabilityGroupId: string;
  // View-specific fields:
  metrics: readonly <ViewName>MetricDto[];
  filters: readonly FilterDto[];
  coverage: CoverageDto;
}

export interface <ViewName>MetricDto {
  metricId: string;
  metricVersion: number;
  label: string;
  value: number | null;
  unit: string;
  measurementClass: 'observed' | 'derived' | 'estimated' | 'heuristic';
  confidence: string | null;
  eligibleN: number;
  knownN: number;
  unknownCount: number;
  coverage: number;
  unavailableReason: string | null;
  evidenceLinks: readonly EvidenceLink[];
}

export interface EvidenceLink {
  label: string;
  route: string; // stable hash URL
  generationToken: string;
}

export interface CoverageDto {
  eligibleN: number;
  knownN: number;
  unknownCount: number;
  coverage: number;
}

export interface FilterDto {
  key: string;
  label: string;
  values: readonly FilterValueDto[];
}

export interface FilterValueDto {
  value: string;
  label: string;
  count: number;
}
```

**Chart series DTO template:**

```ts
export interface ChartSeriesDto {
  seriesId: string;
  label: string;
  chartType: 'time_series' | 'stacked_bar' | 'stacked_area' | 'histogram'
    | 'percentile_bands' | 'scatter' | 'heatmap' | 'box' | 'distribution'
    | 'funnel' | 'annotated_timeline';
  xLabel: string;
  yLabel: string;
  buckets: readonly ChartBucketDto[];
  annotations?: readonly ChartAnnotationDto[];
  analysisReleaseId: string;
  generationToken: string;
}

export interface ChartBucketDto {
  x: string | number;
  y: number | null;
  label: string;
  evidenceLink?: EvidenceLink;
}

export interface ChartAnnotationDto {
  position: string | number;
  label: string;
  type: 'lifecycle' | 'compaction' | 'mode_change' | 'configuration';
}
```

### Step 3 — Implement the data-source query method

Add the query method to `AnalyticsDataSource` in
`packages/db/src/analytics.ts`. Queries must use precomputed rollups and
bounded indexed series — no read-time aggregation, metric derivation, or
transcript scans.

```ts
// packages/db/src/analytics.ts
export interface AnalyticsDataSource {
  // Existing methods...

  get<ViewName>Summary(
    params: <ViewName>SummaryParams,
  ): Promise<<ViewName>SummaryDto>;

  get<ViewName>ChartSeries(
    params: <ViewName>ChartParams,
  ): Promise<readonly ChartSeriesDto[]>;

  get<ViewName>EvidencePage(
    params: EvidencePageParams,
  ): Promise<EvidencePageDto>;
}
```

**Query implementation rules (§11.5):**
- Session open: summary, bounded chart-series, and paginated evidence queries
  only.
- Project/portfolio pages: rollups and bounded indexed series.
- Simple display arithmetic and joins to current baseline summaries are
  allowed; metric formulas and distribution scans are not.
- Cursor pagination is snapshot-consistent against the generation token.

### Step 4 — Add the stable route

Add or update the route in `packages/site/src/router.ts`. Routes are hash-based
(`#/...`) to survive static hosting. Stable hash URLs preserve filter state.

**Route template:**

```ts
// packages/site/src/router.ts
// Add route for the new view
routes.addRoute({
  path: '/<view-path>',
  render: (params) => html`<<view-tag> .params=${params}></<view-tag>>`,
});
```

**Stable URL parameters to preserve:**
- time range;
- project;
- harness;
- model;
- mode;
- task cohort;
- root/inclusive scope;
- confidence;
- selected component/version;
- analysis release;
- return context (breadcrumb origin).

Deleted or superseded evidence resolves to an explanatory tombstone rather
than an unrelated row.

### Step 5 — Implement the Lit page component

Create or update the page component in `packages/site/src/pages/`. The page
component calls the data-source client and passes DTOs to chart/table
components. It contains no SQL or metric formulas.

**Page component template:**

```ts
// packages/site/src/pages/<view-name>-page.ts
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { <ViewName>SummaryDto } from '@lucasschirm/sal-db/dto';
import { analyticsClient } from '../db/analytics-client';

@customElement('<view-tag>')
export class <ViewName>Page extends LitElement {
  @property() params: <ViewName>Params;
  @state() private summary: <ViewName>SummaryDto | null = null;
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private partial = false;

  async connectedCallback() {
    super.connectedCallback();
    try {
      this.summary = await analyticsClient.get<ViewName>Summary(this.params);
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }

  render() {
    if (this.loading) return html`<loading-state></loading-state>`;
    if (this.error) return html`<error-state .message=${this.error}></error-state>`;
    if (!this.summary) return html`<empty-state></empty-state>`;
    return html`
      <breadcrumb .origin=${this.params.returnContext}></breadcrumb>
      <<view-name>-filters .filters=${this.summary.filters}></<view-name>-filters>
      ${this.summary.metrics.map(m => html`
        <metric-card .metric=${m}></metric-card>
      `)}
      <<view-name>-charts .summary=${this.summary}></<view-name>-charts>
    `;
  }
}
```

### Step 6 — Implement chart components with accessibility

Chart components receive series DTOs and contain no SQL or metric formulas.
Use tree-shaken ECharts modules.

**Chart component template:**

```ts
// packages/site/src/components/<view-name>-chart.ts
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { ChartSeriesDto } from '@lucasschirm/sal-db/dto';

@customElement('<view-name>-chart')
export class <ViewName>Chart extends LitElement {
  @property() series: ChartSeriesDto;

  render() {
    return html`
      <div class="chart-container" role="img"
           aria-label=${this.textualSummary()}>
        <echarts-base .option=${this.buildOption()}></echarts-base>
      </div>
      <details class="chart-table-fallback">
        <summary>View as table</summary>
        <data-table .rows=${this.toTableRows()}></data-table>
      </details>
    `;
  }

  private textualSummary(): string {
    // A textual description of the chart for screen readers.
    // e.g. "Time series showing total tokens from Jan 1 to Jan 31,
    //       peaking at 450K on Jan 15."
  }

  private toTableRows(): TableRow[] {
    // Convert chart buckets to tabular data for the fallback.
  }

  private buildOption(): EChartsOption {
    // Build ECharts option from the DTO. No metric formulas here.
  }
}
```

**Accessibility requirements (§11.4, §15.4):**
- Every chart has keyboard interaction.
- Every chart has a textual summary (aria-label or visible text).
- Every chart has a tabular fallback (in a `<details>` element or toggle).
- Color-independent status encoding (never rely on color alone).
- Loading, empty, partial, unavailable, unsupported, integrity-error, and
  stale-rollup states.

### Step 7 — Implement filters

Filters use bounded rollup keys defined by the versioned `rollup_policy`.
Filter DTOs are produced by the data-source, not computed in the UI.

**Supported filter dimensions** (from §8.7 rollup policy):
- model, harness, mode, task cohort, component, confidence;
- time range (bounded by rollup daily buckets);
- root/inclusive scope;
- analysis release.

Unsupported ad hoc analysis is not served by default pages.

### Step 8 — Add evidence links and drill-down navigation

Every metric card and chart bucket must link to its evidence. Evidence
drill-down uses paginated evidence queries with cursor pagination that is
snapshot-consistent against the generation token.

**Navigation hierarchy (§11.2):**

```text
Portfolio (default route)
  -> Project Behavior
    -> Session Evidence

Portfolio / Project / Session
  -> Component Ecosystem
    -> exact project/session/turn/message/invocation evidence
    -> artifact version diff and before/after cohorts
```

Breadcrumbs preserve the originating portfolio/project/session filters.
Component pages retain canonical identity while breadcrumbs preserve filter
context.

### Step 9 — Add data-source contract tests

```ts
// packages/db/tests/analytics-<view-name>.test.ts
describe('AnalyticsDataSource <view-name>', () => {
  it('returns summary with required DTO fields', async () => {
    const ds = createTestDataSource();
    const summary = await ds.get<ViewName>Summary(params);
    expect(summary.analysisReleaseId).toBeDefined();
    expect(summary.generationToken).toBeDefined();
    expect(summary.coverage.eligibleN).toBeGreaterThanOrEqual(0);
  });

  it('cursor pagination is snapshot-consistent', async () => {
    // Page through evidence, then re-page with the same generation token.
    // Results must be consistent.
  });
});
```

### Step 10 — Add site E2E tests

```ts
// packages/site/tests/e2e/<view-name>.spec.ts
test('<view-name> page loads and navigates', async ({ page }) => {
  await page.goto('#/<view-path>');
  await expect(page.locator('<view-tag>')).toBeVisible();
  // Test loading, populated, and empty states.
  // Test keyboard interaction on charts.
  // Test tabular fallback toggle.
  // Test evidence drill-down navigation.
  // Test filter preservation in URL.
});
```

**Command:**

```bash
cd packages/site && pnpm test:e2e -- --grep "<view-name>"
```

### Step 11 — Verify read performance

Ensure the view meets read-performance budgets (§15.5):

- No metric derivation or full transcript scan on session open.
- Indexed/bounded dashboard queries.
- Paginated detailed evidence.
- p95 read latency within environment-tolerant budgets.

**Command:**

```bash
cd packages/db && pnpm vitest run -- -t "performance.*<view-name>"
cd packages/site && pnpm test:e2e -- --grep "<view-name>.*performance"
```

## Completion checklist

- [ ] Data-source DTOs defined in `packages/db/src/dto.ts` with all required
      fields (analysis release, generation token, comparability group,
      coverage, evidence links).
- [ ] Data-source query method implemented in `packages/db/src/analytics.ts`
      using rollups and bounded indexed series (no read-time aggregation).
- [ ] Stable route added in `packages/site/src/router.ts` with filter
      preservation.
- [ ] Lit page component created in `packages/site/src/pages/` with no SQL or
      metric formulas.
- [ ] Chart components created with keyboard interaction, textual summary,
      tabular fallback, and color-independent status encoding.
- [ ] Loading, empty, partial, unavailable, unsupported, integrity-error, and
      stale-rollup states implemented.
- [ ] Filters use bounded rollup keys from the rollup policy.
- [ ] Evidence links and drill-down navigation implemented.
- [ ] Breadcrumbs preserve originating filter context.
- [ ] Deleted/superseded evidence resolves to an explanatory tombstone.
- [ ] Data-source contract tests pass.
- [ ] Site E2E tests pass.
- [ ] Read-performance budgets verified (no transcript scan, indexed queries,
      p95 within budget).
- [ ] `pnpm --filter @lucasschirm/sal-db verify` passes.
- [ ] `pnpm --filter site verify` passes.
- [ ] CI maintenance gate: DTO packages contain no runtime database
      implementation types.
- [ ] CI maintenance gate: required dashboard queries use expected indexes.

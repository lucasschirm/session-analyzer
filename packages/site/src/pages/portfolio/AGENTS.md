# pages/portfolio/

Top-level Portfolio analytics view for the Session Analyzer dashboard.

## Files

- **portfolio-view.ts** — `<portfolio-view>` Lit page. Loads overview, trend, component-utilization, model-harness-cohort, and project-list data from `AnalyticsClient.portfolio`, renders filter controls, metric cards, charts, and a project list.
- **portfolio-chart-helpers.ts** — Mappings from DTOs (`PortfolioOverview`, `PortfolioTrendSeries`, `ComponentUtilizationPage`, `ModelHarnessCohortPage`, `ProjectListPage`) to `ChartSeries`, metric card views, and project table rows.
- **portfolio-params.ts** — Hash-based URL parameter parsing and building, `AnalyticsQuery` construction, and evidence-link URL helpers that preserve filter context.

## Invariants

- DTOs only: this page does not import SQL types or compute canonical metrics.
- Every aggregate shown includes its sample size (n=X) via `AnalyticsToken` / `MetricValueDto` coverage metadata.
- URL filters are round-tripped through `#/portfolio?...` so the filter context (project, harness, model, mode, time range, etc.) survives refresh and back navigation.
- Navigation hierarchy: Portfolio → Project Behavior → Session Evidence. Project links carry a `returnContext` with the current portfolio filter hash.

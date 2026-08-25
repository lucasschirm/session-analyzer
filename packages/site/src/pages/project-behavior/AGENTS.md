# pages/project-behavior/

Project Behavior analytics view for the Session Analyzer dashboard.

## Files

- **project-behavior-view.ts** — `<project-behavior-view>` Lit page. Loads `ProjectBehaviorSummary`, `SessionTrendSeries`, `ConfigurationTimeline`, `OutlierPage`, and `ComparisonPage` from `AnalyticsClient.project`; renders filter controls, metric cards, time-series/distribution/annotated-timeline charts, and cohort/outlier tables.
- **project-behavior-chart-helpers.ts** — Mappings from analytics DTOs to `ChartSeries`, `MetricCardView` rows, outlier row views, and cohort comparison row views.
- **project-behavior-params.ts** — Hash-based URL parameter parsing and building, `AnalyticsQuery` construction, and evidence-link URL helpers that preserve filter context and `returnContext`.

## Invariants

- DTOs only: this page does not import SQL types or compute canonical metrics.
- Every aggregate shown includes its sample size (`n=X`) via `AnalyticsToken` / `MetricValueDto` coverage metadata.
- URL filters are round-tripped through `#/projects/:projectId/behavior?...` so filter context (time range, harness, model, mode, component, task cohort, scope, confidence, analysis release, etc.) survives refresh and back navigation.
- Navigation hierarchy: Portfolio → Project Behavior → Session Evidence. Portfolio project links carry a `returnContext` with the current portfolio filter hash.

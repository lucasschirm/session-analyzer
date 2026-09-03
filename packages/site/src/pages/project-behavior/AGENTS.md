# pages/project-behavior/

Project Behavior ("Project drill-down") analytics view for the Session
Analyzer dashboard (issue #171 — canvas page 1).

## Files

- **project-behavior-view.ts** — `<project-behavior-view>` Lit page. Loads
  `ProjectHeader`, `ProjectStatStrip`, `SessionDurationHistogram`,
  `SessionOutcomeDistribution`, `WeeklyToolErrorRateSeries`, `TopToolsList`,
  and `ProjectModelHarnessCohorts` from `AnalyticsClient.project`; renders
  the breadcrumb + header, the shared `<filter-bar>` (Project chip fixed to
  this project), the stat strip, duration-histogram / outcome-mix row,
  tool-error-rate / top-tools row, and the model×harness cohorts table. The
  canvas's "Compare period" control is deferred — see issue #250 — and is
  not rendered.
- **project-behavior-chart-helpers.ts** — Mappings from analytics DTOs to
  `ChartSeries`, the stat-strip tile view model (including the missing-cost
  "Not reported by N of M harnesses" copy), duration-histogram bin labels
  (derived from the DTO's `startMs`/`endMs`, never hardcoded), the outcome
  legend view model (largest-remainder percentage allocation so bucket
  percentages always sum to exactly 100), and model-cohort table rows
  (low-n flag, inline median-tokens bar scaling).
- **project-behavior-params.ts** — Hash-based URL parameter parsing and
  building, `AnalyticsQuery` construction, evidence-link URL helpers that
  preserve filter context and `returnContext`, and `toFilterBarParams`/
  `fromFilterBarParams` adapters between `ProjectBehaviorParams` and the
  shared `<filter-bar>`'s `PortfolioParams` shape (with the Project chip
  fixed).

## Invariants

- DTOs only: this page does not import SQL types or compute canonical metrics.
- Every aggregate shown includes its sample size (`n=X`) via `AnalyticsToken` / `AggregateStat` coverage metadata.
- URL filters are round-tripped through `#/projects/:projectId?...` so filter context (time range, harness, model, mode, component, task cohort, scope, confidence, analysis release, etc.) survives refresh and back navigation.
- Navigation hierarchy: Portfolio → Project Behavior → Session Evidence. Portfolio project links carry a `returnContext` with the current portfolio filter hash.
- Under the All time-range preset, delta chips render "—" rather than a fabricated comparison (`statStripToView`).
- Missing values (e.g. cost/session when no harness reports it) render via `<stat-tile-missing>`, never as `0` — `.agents/rules/missing-is-never-zero.md`.

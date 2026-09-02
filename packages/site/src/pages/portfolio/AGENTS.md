# pages/portfolio/

Top-level Portfolio analytics home page (`/`) for the Session Analyzer
dashboard, redesigned in issue #170 to the canvas anatomy: title row, filter
bar, 4-up KPI band, trend+model-bars row, heatmap+domains row, project
leaderboard.

## Files

- **portfolio-view.ts** — `<portfolio-view>` Lit page. Loads the KPI band, trend, sessions-by-model, model×harness matrix, invocations-by-domain, and project-leaderboard DTOs from `AnalyticsClient.portfolio` (issue #169) concurrently, each into its own `PanelState` so one card's failure never blanks another. Renders the page-owned title row (swaps the global header on `/` only — see `app-root.ts`), the filter bar (issue #167), the shared card library (issue #166: `stat-tile-hero`/`stat-tile-delta`/`stat-tile-missing`/`stat-ring`), and the chart layer (issue #168: `analytics-chart` for time-series/horizontal-bar/heatmap).
- **portfolio-chart-helpers.ts** — Pure DTO→view-model mappers: `PortfolioKpiBand` → KPI tile props (sessions hero, tokens delta, cost delta/missing, clean-completion ring/missing), `SessionsByModelBar`/`ModelHarnessMatrix`/`InvocationsByDomain` → `ChartSeries`, `ProjectLeaderboard` → leaderboard row view models. No DOM/Lit imports — unit-tested directly.
- **portfolio-params.ts** — Hash-based URL parameter parsing and building, `AnalyticsQuery` construction, range-preset resolution, and evidence-link URL helpers that preserve filter context.
- **request-sequence-guard.ts** — Discards a stale in-flight response when a newer filter change has already superseded it.

## Invariants

- DTOs only: this page does not import SQL types or compute canonical metrics — all derivation lives in `portfolio-chart-helpers.ts` as pure functions; the component only formats via `lib/format.ts`.
- Every aggregate shown includes its sample size (n=X) via `AnalyticsToken` / `MetricValueDto` coverage metadata.
- Missing/not-applicable values (unbounded "All" range deltas, unreported cost, unclassified clean-completion, never-observed model×harness cells) render "—" / the dedicated missing-state tile — never a fabricated `0`.
- Invocations-by-domain is exactly the four canonical kinds (Tool/Skill/Agent/Sub Agent); MCP is never a fifth peer bucket — it surfaces only as an "MCP servers →" footnote link to `/mcp`.
- The project leaderboard is always an all-time ranking (its query omits the time-range filter) even while the rest of the page respects the active range preset.
- URL filters are round-tripped through `#/?...` so the filter context (project, harness, model, mode, time range, sessions scope) survives refresh and back navigation.
- Navigation hierarchy: Portfolio → Project Behavior → Session Evidence. Project links carry a `returnContext` with the current portfolio filter hash.
